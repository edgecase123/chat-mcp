import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 🛑 BEFORE any import that resolves a state path, or the supervisor binds a
// socket inside the OPERATOR'S LIVE ~/.chat-mcp.
process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), "chat-mcp-respawn-"));

const { migrate } = await import("../../src/storage/db.js");
const { startSupervisor } = await import("../../src/supervise/index.js");
const { deliverToSupervisor } = await import("../../src/supervise/socket.js");
const { claudeSpawn } = await import("../../src/adapters/claude-spawn.js");
const { TurnQueue } = await import("../../src/supervise/turn-queue.js");
const dao = await import("../../src/storage/dao.js");
import type { AgentChild, SpawnOptions } from "../../src/supervise/child.js";

/**
 * 🛑 A RESPAWN DISCARDS EVERY QUEUED PROMPT, AND A THROW IS NOT REQUIRED.
 *
 * `replaceChild` and `doRestart` both drain the queue, respawn, then re-offer
 * what they drained. `TurnQueue.offer` DROPS a prompt whose message ids it has
 * already seen, `drain()` does not clear that set, and there is one queue per
 * supervisor — `supervise/index.ts` has a single `new TurnQueue`. So the
 * re-offer returns `duplicate` and the
 * operator's unsent work is gone on the SUCCESS path.
 *
 * ⚠️ THE DOCBLOCK ON `replaceChild` SAYS THE OPPOSITE — "THE QUEUE IS DRAINED,
 * NOT DISCARDED". That is the claim these tests falsify.
 *
 * A throwing spawn was a SECOND, independent defect on the same two lines: the
 * spawn sat outside any `try`, so the re-offer never ran at all. The
 * supervisor now STAYS UP and PARKS what it drained, per lee's ruling of
 * 2026-11-15, and the throw is re-raised so the caller still learns of it.
 *
 * The queue has no reader but a child, so "the prompts survived" can only be
 * asked of a later spawn. That is why each supervisor test performs a second
 * one.
 */

import { releasePointerTurn } from "../support/handoff-pointer.js";

const DIRS = [process.cwd()];

interface FakeChild {
  readonly opts: SpawnOptions;
  readonly sent: string[];
  finishTurn: () => void;
  fireExit: () => void;
}

/**
 * ⚠️ `kill()` DOES NOT FIRE `onExit` HERE, like the real thing. A containerized
 * child's kill spawns `docker stop` detached, so the exit is a later event.
 * A fake that exits synchronously lands before the generation bump and cannot
 * see this class of bug at all.
 *
 * 🛑 SO THE TEST MUST FIRE IT, AND THE FIRST VERSION OF THIS FILE DID NOT.
 * A killed child really does exit, and that exit used to drain the prompts
 * parked by a failed respawn. Nothing here could have said no. Found by
 * claude2 on review, reproduced twice.
 */
function recordingChild(children: FakeChild[]) {
  return (opts: SpawnOptions): AgentChild => {
    const sent: string[] = [];
    let endTurn: (() => void) | undefined;
    let onExit: ((c: number | null, s: string | null) => void) | undefined;

    children.push({
      opts,
      sent,
      finishTurn: () => endTurn?.(),
      fireExit: () => onExit?.(null, "SIGTERM"),
    });

    return {
      reportsUsage: false,
      reportsContext: true,
      send: (t) => sent.push(t),
      onTurnEnd: (cb) => {
        endTurn = cb;
      },
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
      kill: () => undefined,
    };
  };
}

/** Spawns normally except on the listed call numbers, which throw. */
function spawnFailingOn(failCalls: readonly number[], children: FakeChild[]) {
  const make = recordingChild(children);
  let calls = 0;

  return (opts: SpawnOptions): AgentChild => {
    calls += 1;
    if (failCalls.includes(calls))
      throw new Error(`spawn refused on call ${calls}`);

    return make(opts);
  };
}

async function supervisorFor(
  handle: string,
  spawnChild: (o: SpawnOptions) => AgentChild,
  children: FakeChild[],
) {
  const db = new DatabaseSync(":memory:");
  migrate(db);

  const sup = await startSupervisor({
    handle,
    vendor: claudeSpawn,
    db,
    extraDirs: DIRS,
    spawnChild,
    log: () => undefined,
  });

  // The handoff pointer holds the child's first turn; see `releasePointerTurn`.
  releasePointerTurn(children[0]!.sent, children[0]);

  return { sup, db };
}

/** Whatever the supervisor does with a throw, the test must not die of it. */
async function deliver(
  handle: string,
  envelope: Record<string, unknown>,
): Promise<unknown> {
  return deliverToSupervisor(handle, {
    id: Number(envelope.id),
    to: handle,
    from: "lee",
    ts: Date.now(),
    ...envelope,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any).then(
    () => null,
    (e: unknown) => e,
  );
}

/**
 * The state both tests need: one prompt in flight, one prompt QUEUED behind
 * it. Without the second the drain is empty and the test is vacuous.
 */
async function withOnePromptQueued(handle: string, children: FakeChild[]) {
  await deliver(handle, { id: 1, body: "first, so the child is mid-turn" });
  assert.equal(
    children[0]?.sent.length,
    1,
    "the first prompt never reached the child",
  );

  await deliver(handle, { id: 2, body: "QUEUED WORK" });
  assert.equal(
    children[0]?.sent.length,
    1,
    "the second prompt went out, so nothing is queued",
  );
}

const approval = {
  approvalId: 1,
  decision: "approve" as const,
  requested: "rm in '/tmp/x.txt'",
  grant: "Bash(rm -f /tmp/x.txt)",
  sessionId: "sess-1",
};

test("🚨 a throwing respawn on an APPROVAL does not lose the queued prompts", async () => {
  const children: FakeChild[] = [];
  const handle = `rt-${process.pid}-approve`;
  // Call 1 is the initial child. Call 2 is the approval's replacement.
  const { sup, db } = await supervisorFor(
    handle,
    spawnFailingOn([2], children),
    children,
  );

  try {
    await withOnePromptQueued(handle, children);

    await deliver(handle, { id: 3, approval });
    assert.equal(
      children.length,
      1,
      "the replacement spawn was supposed to throw",
    );

    // 🛑 THE KILLED CHILD REALLY DOES EXIT, AND ITS HANDLER DRAINS. Without
    // this line the park looks intact and is not.
    children[0]!.fireExit();

    // The only reader the queue has is a child, so ask a LATER one.
    await deliver(handle, { id: 4, control: { kind: "restart", mode: "now" } });

    const revived = children[1];
    assert.ok(
      revived,
      "no child was ever spawned again, so the queue cannot be read",
    );

    // The replacement is fresh, so it gets a pointer FIRST and the carried
    // prompt waits behind it. See `releasePointerTurn`.
    releasePointerTurn(revived.sent, revived);
    assert.ok(
      revived.sent.some((t) => t.includes("QUEUED WORK")),
      `the failed respawn discarded the queued prompt (the new child got ${JSON.stringify(revived.sent)})`,
    );
  } finally {
    await sup.stop();
    db.close();
  }
});

test("🚨 a throwing respawn on an operator RESTART does not lose the queued prompts", async () => {
  const children: FakeChild[] = [];
  const handle = `rt-${process.pid}-restart`;
  const { sup, db } = await supervisorFor(
    handle,
    spawnFailingOn([2], children),
    children,
  );

  try {
    await withOnePromptQueued(handle, children);

    await deliver(handle, { id: 3, control: { kind: "restart", mode: "now" } });
    assert.equal(children.length, 1, "the restart spawn was supposed to throw");

    // The same stale exit, on the restart path.
    children[0]!.fireExit();

    await deliver(handle, { id: 4, control: { kind: "restart", mode: "now" } });

    const revived = children[1];
    assert.ok(
      revived,
      "no child was ever spawned again, so the queue cannot be read",
    );

    releasePointerTurn(revived.sent, revived);
    assert.ok(
      revived.sent.some((t) => t.includes("QUEUED WORK")),
      `the failed restart discarded the queued prompt (the new child got ${JSON.stringify(revived.sent)})`,
    );
  } finally {
    await sup.stop();
    db.close();
  }
});

/**
 * 🛑 THE HEADLINE, AND IT NEEDS NO THROW. A restart that spawns perfectly well
 * still loses the queued prompt, because the re-offer is refused as a
 * duplicate. This was written as a positive control for the two tests above
 * and failed, which is how the unconditional defect was found.
 *
 * ⚠️ `withOnePromptQueued` is the control that keeps this honest: it asserts a
 * prompt DOES reach a live child, so a fixture that could never observe a
 * send would fail there instead of here.
 */
test("🚨 a respawn that SUCCEEDS still carries the queued prompt to the replacement", async () => {
  const children: FakeChild[] = [];
  const handle = `rt-${process.pid}-success`;
  const { sup, db } = await supervisorFor(
    handle,
    spawnFailingOn([], children),
    children,
  );

  try {
    await withOnePromptQueued(handle, children);

    await deliver(handle, { id: 3, control: { kind: "restart", mode: "now" } });

    const replacement = children[1];
    assert.ok(replacement, "the restart spawned no replacement");

    releasePointerTurn(replacement.sent, replacement);
    assert.ok(
      replacement.sent.some((t) => t.includes("QUEUED WORK")),
      `the respawn discarded the queued prompt (the replacement got ${JSON.stringify(replacement.sent)})`,
    );
  } finally {
    await sup.stop();
    db.close();
  }
});

/**
 * 🛑 THE CHEAPEST INSTRUMENT, AND THE ONE THAT NAMES THE CAUSE. The three
 * tests above go through a supervisor, a socket and a database to observe one
 * `Set`. This asks the queue directly, so a future reader is not left
 * guessing which of the moving parts dropped the prompt.
 */
test("🚨 a drained prompt can be offered again", () => {
  const sent: string[] = [];
  const queue = new TurnQueue({ send: (p) => sent.push(p.text) });

  assert.equal(queue.offer({ text: "A", messageIds: [1] }), "sent");
  assert.equal(queue.offer({ text: "B", messageIds: [2] }), "queued");

  const unsent = queue.drain();
  assert.deepEqual(
    unsent.map((p) => p.text),
    ["B"],
    "the fixture never queued anything, so this test measures nothing",
  );

  assert.equal(
    queue.offer(unsent[0]!),
    "duplicate",
    "the de-dup gate is gone, so a bus re-read will ask the agent the same thing twice",
  );
  assert.equal(
    queue.reoffer(unsent[0]!),
    "sent",
    "a drained prompt cannot be re-offered, so every respawn loses the queue",
  );
  assert.deepEqual(
    sent,
    ["A", "B"],
    "the re-offered prompt was never written to the child",
  );
});

/**
 * 🛑 THE BUS MUST LEARN THE CHILD IS GONE, AND THE GENERATION BUMP CAN HIDE IT.
 *
 * `doRestart` had no `clearAgentPid` of its own and relied entirely on the
 * killed child's `onExit`. Bumping the generation on the throw path suppressed
 * that exit, so a failed restart left a dead child reading ONLINE. Found by
 * claude2 on review of `94badb8`; `takeChildOffline` is now shared by both
 * respawn paths.
 */
async function supervisorWithAgentRow(
  handle: string,
  spawnChild: (o: SpawnOptions) => AgentChild,
) {
  const db = new DatabaseSync(":memory:");
  migrate(db);
  dao.upsertAgent(db, {
    handle: `${handle}-agent`,
    pid: process.pid,
    session_id: "s",
    display_name: `${handle}-agent`,
    metadata: {},
  });
  assert.equal(
    dao.getAgent(db, `${handle}-agent`)?.online,
    true,
    "the fixture must start online",
  );

  const sup = await startSupervisor({
    handle,
    vendor: claudeSpawn,
    db,
    extraDirs: DIRS,
    spawnChild,
    log: () => undefined,
  });

  return { sup, db };
}

test("🚨 a failed RESTART takes the dead child offline on the bus", async () => {
  const children: FakeChild[] = [];
  const handle = `rt-${process.pid}-offline-restart`;
  const { sup, db } = await supervisorWithAgentRow(
    handle,
    spawnFailingOn([2], children),
  );

  try {
    await deliver(handle, { id: 1, control: { kind: "restart", mode: "now" } });
    assert.equal(children.length, 1, "the restart spawn was supposed to throw");

    assert.equal(dao.getAgent(db, `${handle}-agent`)?.pid, null);
    assert.equal(dao.getAgent(db, `${handle}-agent`)?.online, false);
  } finally {
    await sup.stop();
    db.close();
  }
});

/** The sibling path, which already did this before the generation bump. */
test("🚨 a failed REPLACE takes the dead child offline on the bus", async () => {
  const children: FakeChild[] = [];
  const handle = `rt-${process.pid}-offline-replace`;
  const { sup, db } = await supervisorWithAgentRow(
    handle,
    spawnFailingOn([2], children),
  );

  try {
    await deliver(handle, { id: 1, approval });
    assert.equal(
      children.length,
      1,
      "the replacement spawn was supposed to throw",
    );

    assert.equal(dao.getAgent(db, `${handle}-agent`)?.pid, null);
    assert.equal(dao.getAgent(db, `${handle}-agent`)?.online, false);
  } finally {
    await sup.stop();
    db.close();
  }
});

/**
 * 🛑 THE OTHER STALE SIGNAL, AND MY TESTS DID NOT REACH IT. claude2's probe B:
 * a late `onTurnEnd` from the killed child runs `turnEnded()`, which dispatches
 * a parked prompt straight into a dead process. The generation bump covers it
 * because `ifCurrent` wraps every callback, not just `onExit` — but nothing
 * here proved that, and an untested half of a guard is the half that rots.
 */
test("🚨 a late turn-end from the KILLED child does not dispatch a parked prompt", async () => {
  const children: FakeChild[] = [];
  const handle = `rt-${process.pid}-stale-turnend`;
  const { sup, db } = await supervisorFor(
    handle,
    spawnFailingOn([2], children),
    children,
  );

  try {
    await withOnePromptQueued(handle, children);

    await deliver(handle, { id: 3, control: { kind: "restart", mode: "now" } });
    assert.equal(children.length, 1, "the restart spawn was supposed to throw");

    const dead = children[0]!;
    assert.equal(
      dead.sent.length,
      1,
      "the dead child had one prompt before the stale signal",
    );

    // The killed child's turn-end lands late.
    dead.finishTurn();

    assert.equal(
      dead.sent.length,
      1,
      `a stale turn-end wrote a parked prompt to a dead child (it got ${JSON.stringify(dead.sent)})`,
    );

    // And the work is still there for a child that exists.
    await deliver(handle, { id: 4, control: { kind: "restart", mode: "now" } });

    releasePointerTurn(children[1]!.sent, children[1]);

    assert.ok(
      children[1]?.sent.some((t) => t.includes("QUEUED WORK")),
      "the parked prompt did not survive to the revived child",
    );
  } finally {
    await sup.stop();
    db.close();
  }
});
