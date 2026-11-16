import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 🛑 BEFORE any import that resolves a state path. Short prefix and handles
// because a unix socket path is capped at 104 bytes on macOS.
process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), "cm-ev-"));

const { migrate } = await import("../../src/storage/db.js");
const dao = await import("../../src/storage/dao.js");
const { startSupervisor } = await import("../../src/supervise/index.js");
const { claudeSpawn } = await import("../../src/adapters/claude-spawn.js");
const { childHandleFor } = await import("../../src/supervise/grant.js");
import type { AgentChild, SpawnOptions } from "../../src/supervise/child.js";

/**
 * 🛑 A CHILD'S DEATH REACHED THE SUPERVISOR'S OWN LOG FILE AND NOTHING ELSE.
 *
 * `clearAgentPid` already makes the handle read offline, which an operator
 * sees as a GAP rather than a death. lee ruled on 2026-11-16: surface the exit
 * as a bus event, and emit it BEFORE the supervisor exits.
 *
 * ⚠️ THE AUDIENCE IS BOTH HANDLES' ROOMS, AND THAT IS A MEASUREMENT RATHER
 * THAN A PREFERENCE. The handle that goes offline is the CHILD's `-agent`
 * handle, and on the live bus no `-agent` handle is a member of anything —
 * 11 `room_members` rows, 0 of them. Peers know the agent by the SUPERVISOR's
 * handle. Announcing to only one of the two reaches nobody under one of the
 * two registration shapes.
 */

interface FakeChild {
  fireExit: () => void;
}

function recordingChild(children: FakeChild[], exitOnKill = false) {
  return (_opts: SpawnOptions): AgentChild => {
    let onExit: ((c: number | null, s: string | null) => void) | undefined;

    children.push({ fireExit: () => onExit?.(243, null) });

    return {
      reportsUsage: false,
      reportsContext: true,
      send: () => undefined,
      onTurnEnd: () => undefined,
      onContext: () => undefined,
      onUsage: () => undefined,
      onDenial: () => undefined,
      onSession: (cb) => cb("sess-from-fake"),
      onEvent: () => undefined,
      onStderr: () => undefined,
      onExit: (cb) => {
        onExit = cb;
      },
      kill: () => (exitOnKill ? onExit?.(null, "SIGTERM") : undefined),
    };
  };
}

interface Announcement {
  to: string;
  body: string;
  kind: string;
}

/**
 * System messages posted AFTER `afterId`.
 *
 * 🛑 THE FLOOR IS LOAD-BEARING AND IT IS NOT DEFENSIVE TIDYING. `joinRoom`
 * announces the join as a `system` message of its own (#277, PR 280), so a
 * fixture that puts a handle in a room has already written one row per room
 * before the test does anything. Without the floor this counter answered 1 for
 * a death that was never announced: two tests in this file passed against NO
 * implementation, and both CONTROLS failed.
 */
function announcements(db: DatabaseSync, afterId: number): Announcement[] {
  return db
    .prepare(
      `SELECT to_handle AS "to", body, kind FROM messages
       WHERE from_handle = ? AND id > ? ORDER BY id ASC`,
    )
    .all(dao.SYSTEM_HANDLE, afterId) as unknown as Announcement[];
}

/** The newest message id, so a later count can exclude the fixture's own. */
function lastMessageId(db: DatabaseSync): number {
  const row = db
    .prepare(`SELECT COALESCE(MAX(id), 0) AS id FROM messages`)
    .get() as unknown as { id: number };

  return row.id;
}

async function supervisorIn(
  handle: string,
  rooms: { room: string; member: string }[],
  children: FakeChild[],
  exitOnKill = false,
) {
  const db = new DatabaseSync(":memory:");
  migrate(db);

  for (const { room, member } of rooms) dao.joinRoom(db, room, member);

  const sup = await startSupervisor({
    handle,
    vendor: claudeSpawn,
    db,
    extraDirs: [process.cwd()],
    spawnChild: recordingChild(children, exitOnKill),
    log: () => undefined,
  });

  return { sup, db, floor: lastMessageId(db) };
}

/** Let the exit handler's async teardown settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise(setImmediate);
}

test("🚨 a child's own exit is announced to the rooms the agent's peers know it in", async () => {
  const children: FakeChild[] = [];
  const handle = `ea${process.pid}`;
  const { sup, db, floor } = await supervisorIn(
    handle,
    [{ room: "#r1", member: handle }],
    children,
  );

  try {
    children[0]!.fireExit();
    await settle();

    const posted = announcements(db, floor).filter((a) => a.to === "#r1");

    assert.equal(
      posted.length,
      1,
      "the child's death reached the supervisor's log file and nothing else",
    );
    assert.match(
      posted[0]!.body,
      /exited/,
      "the announcement does not say the child exited",
    );
    assert.match(
      posted[0]!.body,
      /243/,
      "the announcement drops the exit code, which is the one detail an operator starts from",
    );
    assert.equal(
      posted[0]!.kind,
      "alert",
      "an unexpected death was delivered as an ordinary message, so it misses the alert lane",
    );
  } finally {
    await sup.stop("now").catch(() => undefined);
    db.close();
  }
});

/**
 * 🛑 THE OTHER HALF OF THE UNION. The child handle is the one that goes
 * offline, so a room that knows the agent by THAT handle must hear it too.
 */
test("🚨 the exit is announced to a room the CHILD handle is a member of", async () => {
  const children: FakeChild[] = [];
  const handle = `ec${process.pid}`;
  const { sup, db, floor } = await supervisorIn(
    handle,
    [{ room: "#r2", member: childHandleFor(handle) }],
    children,
  );

  try {
    children[0]!.fireExit();
    await settle();

    assert.equal(
      announcements(db, floor).filter((a) => a.to === "#r2").length,
      1,
      "the room that knows the agent by its child handle was never told",
    );
  } finally {
    await sup.stop("now").catch(() => undefined);
    db.close();
  }
});

/**
 * 🛑 THE DEDUPE CONTROL. Both handles can be in the same room, and a union
 * built by concatenation posts the same death twice.
 */
test("🚨 a room BOTH handles are in is told exactly once", async () => {
  const children: FakeChild[] = [];
  const handle = `ed${process.pid}`;
  const { sup, db, floor } = await supervisorIn(
    handle,
    [
      { room: "#r3", member: handle },
      { room: "#r3", member: childHandleFor(handle) },
    ],
    children,
  );

  try {
    children[0]!.fireExit();
    await settle();

    assert.equal(
      announcements(db, floor).filter((a) => a.to === "#r3").length,
      1,
      "the same death was announced twice in one room",
    );
  } finally {
    await sup.stop("now").catch(() => undefined);
    db.close();
  }
});

/**
 * 🛑 THE ORDER IS THE RULING, NOT A DETAIL. lee, 2026-11-16: emit the exit
 * event, THEN exit. `onStopped` is wired to `process.exit(0)` in
 * `src/index.ts`, so an announcement after it is an announcement that never
 * happens.
 *
 * ⚠️ WHAT THIS TEST CANNOT SEE, measured rather than assumed: moving the
 * announce TEXTUALLY below `void finishShutdown()` leaves all nine tests
 * green. `finishShutdown` returns at its first `await`, so synchronous code
 * after the call still runs before `onStopped`. Only a mutant that crosses an
 * await boundary — `finishShutdown().then(() => announce)` — fails this, and
 * it fails this one alone.
 */
test("🚨 the exit event is on the bus BEFORE the supervisor reports stopped", async () => {
  const children: FakeChild[] = [];
  const handle = `eo${process.pid}`;
  const { sup, db, floor } = await supervisorIn(
    handle,
    [{ room: "#r4", member: handle }],
    children,
  );

  let announcedWhenStopped: number | null = null;
  sup.onStopped(() => {
    announcedWhenStopped = announcements(db, floor).filter(
      (a) => a.to === "#r4",
    ).length;
  });

  try {
    children[0]!.fireExit();
    await settle();

    assert.equal(
      announcedWhenStopped,
      1,
      "the supervisor reported stopped before the exit reached the bus, and `onStopped` is wired to process.exit(0)",
    );
  } finally {
    await sup.stop("now").catch(() => undefined);
    db.close();
  }
});

/**
 * 🚨 CONTROL: AN OPERATOR'S OWN STOP IS NOT A DEATH. They asked for it, and a
 * siren for a requested shutdown is the alert lane going stale.
 */
test("🚨 a stop announces nothing, even though its kill fires the exit handler", async () => {
  const children: FakeChild[] = [];
  const handle = `es${process.pid}`;
  const { sup, db, floor } = await supervisorIn(
    handle,
    [{ room: "#r5", member: handle }],
    children,
    true,
  );

  try {
    await sup.stop("now");
    await settle();

    assert.equal(
      announcements(db, floor).filter((a) => a.to === "#r5").length,
      0,
      "a stop the operator asked for was announced as an unexpected death",
    );
  } finally {
    db.close();
  }
});

/**
 * 🚨 CONTROL: A REPLACE IS NOT A DEATH EITHER. The replacement is already
 * running, and `replacingChild` is what distinguishes the two.
 */
test("🚨 a replace announces nothing, because the new child is live", async () => {
  const children: FakeChild[] = [];
  const handle = `ep${process.pid}`;
  const { sup, db, floor } = await supervisorIn(
    handle,
    [{ room: "#r6", member: handle }],
    children,
    true,
  );

  try {
    const { deliverToSupervisor } =
      await import("../../src/supervise/socket.js");

    await deliverToSupervisor(handle, {
      id: 1,
      to: handle,
      from: "lee",
      ts: Date.now(),
      body: "so the first child exists",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    await deliverToSupervisor(handle, {
      id: 2,
      to: handle,
      from: "lee",
      ts: Date.now(),
      approval: {
        approvalId: 1,
        decision: "approve",
        requested: "rm in '/tmp/x.txt'",
        grant: "Bash(rm -f /tmp/x.txt)",
        sessionId: "sess-1",
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    assert.equal(
      children.length,
      2,
      "the approval was supposed to replace the child",
    );

    await settle();

    assert.equal(
      announcements(db, floor).filter((a) => a.to === "#r6").length,
      0,
      "a replaced child was mourned while its replacement was running",
    );
  } finally {
    await sup.stop("now").catch(() => undefined);
    db.close();
  }
});
