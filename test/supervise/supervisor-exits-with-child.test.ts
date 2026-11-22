import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 🛑 BEFORE any import that resolves a state path, or the supervisor binds a
// socket inside the OPERATOR'S LIVE ~/.chat-mcp. The prefix and the handles
// are short because a unix socket path is capped at 104 bytes on macOS.
process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), "cm-sx-"));

const { migrate } = await import("../../src/storage/db.js");
const { startSupervisor } = await import("../../src/supervise/index.js");
const { claudeSpawn } = await import("../../src/adapters/claude-spawn.js");
import type { AgentChild, SpawnOptions } from "../../src/supervise/child.js";

/**
 * 🛑 A SUPERVISOR OUTLIVES ITS CHILD AND CANNOT BE REACHED TO BE TOLD TO STOP.
 *
 * PR 251 closed the wake socket when the child exits on its own, which stopped
 * the false `queued: 'sent'`. `stop` and `restart` arrive ONLY as
 * `envelope.control` over that same socket, so closing it leaves a process
 * with no child, no socket, and no way to be asked anything. `kill <pid>` was
 * the only end.
 *
 * lee ruled on 2026-11-16: the supervisor exits. `onStopped` is the exit —
 * `src/index.ts` wires it to `process.exit(0)`.
 *
 * ⚠️ THE OTHER TWO TESTS ARE THE CONTROLS, and they are the reason this is not
 * one unconditional call. A replaced child's exit must leave a live supervisor
 * alone, and a stop must still report stopped exactly once.
 */

interface FakeChild {
  readonly sent: string[];
  fireExit: () => void;
}

function recordingChild(children: FakeChild[], exitOnKill = false) {
  return (_opts: SpawnOptions): AgentChild => {
    const sent: string[] = [];
    let onExit: ((c: number | null, s: string | null) => void) | undefined;

    children.push({ sent, fireExit: () => onExit?.(243, null) });

    return {
      reportsUsage: false,
      reportsContext: true,
      send: (t) => sent.push(t),
      onTurnEnd: () => undefined,
      onContext: () => undefined,
      onUsage: () => undefined,
      onDenial: () => undefined,
      onToolCall: () => undefined,
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

async function supervisorFor(
  handle: string,
  children: FakeChild[],
  exitOnKill = false,
) {
  const db = new DatabaseSync(":memory:");
  migrate(db);

  const sup = await startSupervisor({
    handle,
    vendor: claudeSpawn,
    db,
    extraDirs: [process.cwd()],
    spawnChild: recordingChild(children, exitOnKill),
    log: () => undefined,
  });

  return { sup, db };
}

/** Let the exit handler's async teardown settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise(setImmediate);
}

test("🚨 a child that exits on its own stops the supervisor, which is the only thing that can end it", async () => {
  const children: FakeChild[] = [];
  const handle = `sx${process.pid}`;
  const { sup, db } = await supervisorFor(handle, children);

  let stopped = 0;
  sup.onStopped(() => {
    stopped += 1;
  });

  try {
    children[0]!.fireExit();
    await settle();

    assert.equal(
      stopped,
      1,
      "the supervisor survived its child with no socket to be reached on, so only `kill <pid>` could end it",
    );
  } finally {
    await sup.stop("now").catch(() => undefined);
    db.close();
  }
});

/**
 * 🛑 THE CONTROL FOR THE `replacingChild` HALF. An approval replaces the child,
 * and the outgoing child's exit must not stop a supervisor whose replacement is
 * already running.
 *
 * ⚠️ THIS FAKE EXITS FROM `kill()`. That is what makes the stale exit CURRENT
 * by generation and therefore able to reach the handler at all.
 */
test("🚨 a replace whose kill exits SYNCHRONOUSLY does not stop the supervisor", async () => {
  const children: FakeChild[] = [];
  const handle = `sr${process.pid}`;
  const { sup, db } = await supervisorFor(handle, children, true);

  let stopped = 0;
  sup.onStopped(() => {
    stopped += 1;
  });

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
      stopped,
      0,
      "the outgoing child's exit stopped a supervisor whose replacement was already live",
    );
  } finally {
    await sup.stop("now").catch(() => undefined);
    db.close();
  }
});

/**
 * 🛑 THE CONTROL FOR THE `hasStopped` HALF, AND FOR THE COUNT.
 *
 * `doStop` kills the child without moving the generation, so that exit is
 * current and the handler runs. If the handler fires `onStopped` too, a stop
 * reports stopped TWICE — and `src/index.ts` wires that to `process.exit(0)`.
 */
test("🚨 a stop reports stopped exactly once, even though its own kill fires the exit handler", async () => {
  const children: FakeChild[] = [];
  const handle = `sp${process.pid}`;
  const { sup, db } = await supervisorFor(handle, children, true);

  let stopped = 0;
  sup.onStopped(() => {
    stopped += 1;
  });

  try {
    await sup.stop("now");
    await settle();

    assert.equal(stopped, 1, "a stop reported itself stopped more than once");
  } finally {
    db.close();
  }
});

/**
 * 🛑 THE CONTROL FOR `hasStopped = true` ON THE OWN-EXIT PATH, and it exists
 * because a mutant that deleted that line broke NOTHING. The whole point of
 * the flag is a stop that arrives AFTER the child died, and no test reached
 * that state — the other tests here stop the supervisor only in their
 * `finally`, where nothing is asserted any more.
 *
 * The SIGINT handler in `src/index.ts` is the caller that can still arrive: a
 * bus-delivered stop cannot, its socket is already closed. Without the flag
 * `doStop` runs a second teardown and fires `onStopped` a second time, and
 * `onStopped` is wired to `process.exit(0)`.
 */
test("🚨 a stop arriving after the child already died does not report stopped twice", async () => {
  const children: FakeChild[] = [];
  const handle = `sa${process.pid}`;
  const { sup, db } = await supervisorFor(handle, children);

  let stopped = 0;
  sup.onStopped(() => {
    stopped += 1;
  });

  try {
    children[0]!.fireExit();
    await settle();

    assert.equal(stopped, 1, "the own exit never reported stopped at all");

    // This is the SIGINT path: the operator hits ctrl-C on a supervisor whose
    // child is already gone.
    await sup.stop("now");
    await settle();

    assert.equal(
      stopped,
      1,
      "a stop after the child's own exit tore everything down a second time and reported stopped again",
    );
  } finally {
    db.close();
  }
});
