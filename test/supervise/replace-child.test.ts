import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { migrate } from '../../src/storage/db.js';
import type { AgentChild, SpawnOptions } from '../../src/supervise/child.js';
import { startSupervisor } from '../../src/supervise/index.js';
import { deliverToSupervisor } from '../../src/supervise/socket.js';

/**
 * 🛑 THE APPROVAL PATH LOOKED FIXED AND WAS NOT.
 *
 * The child was spawned ONCE. A grant recorded the command, sent the child a
 * prompt saying it was now allowed, and never changed its `--allowedTools`.
 * The next attempt would be denied again, and the prompt made the grant look
 * like it had worked. `grantedCommands` was written and never read.
 *
 * `tsc` cannot see a variable that is only ever pushed to, and the earlier
 * guard asserted the prompt was BUILT rather than that the flags CHANGED.
 */

const DIRS = [process.cwd()];

interface FakeChild {
  readonly opts: SpawnOptions;
  readonly sent: string[];
  finishTurn: () => void;
  exit: () => void;
}

/**
 * 🛑 THE FAKE RECORDS ITS CALLBACKS INSTEAD OF SWALLOWING THEM.
 *
 * The previous version used `onTurnEnd: () => undefined`, so the suite was
 * green while every replacement child hung — it certified the one path it
 * could not exercise. claude1 flagged incomplete fakes twice before this
 * finally bit. A fake that drops a callback is testing a child that cannot
 * exist.
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
      exit: () => onExit?.(0, null),
    });

    return {
      reportsUsage: false,
      send: (t) => sent.push(t),
      onTurnEnd: (cb) => {
        endTurn = cb;
      },
      onUsage: () => undefined,
      onDenial: () => undefined,
      onSession: (cb) => cb('sess-from-fake'),
      onEvent: () => undefined,
      onExit: (cb) => {
        onExit = cb;
      },
      // 🛑 A REAL kill() ENDS THE PROCESS AND FIRES onExit. A fake that does
      // nothing hides exactly the bug where a dead child's exit handler
      // mutates the live queue.
      kill: () => onExit?.(null, 'SIGTERM'),
    };
  };
}

async function supervisorFor(handle: string, children: FakeChild[]) {
  const db = new DatabaseSync(':memory:');
  migrate(db);

  return startSupervisor({
    handle,
    db,
    extraDirs: DIRS,
    spawnChild: recordingChild(children),
    log: () => undefined,
  });
}

test('an APPROVAL respawns the child with the command added to its allowlist', async () => {
  const children: FakeChild[] = [];
  const sup = await supervisorFor(`rc-${process.pid}-a`, children);

  try {
    assert.equal(children.length, 1, 'the first child never spawned');
    assert.ok(
      !children[0]?.opts.grant?.allowed.includes('Bash(rm -f /tmp/x.txt)'),
      'already granted before approval',
    );

    await deliverToSupervisor(`rc-${process.pid}-a`, {
      id: 1,
      to: `rc-${process.pid}-a`,
      from: 'lee',
      ts: Date.now(),
      approval: {
        approvalId: 1,
        decision: 'approve',
        // 🛑 TWO FIELDS ON PURPOSE. `requested` is the prose a human read;
        // `grant` is what the allowlist understands. Sending the prose
        // granted nothing and looped — measured live.
        requested: "rm in '/tmp/x.txt'",
        grant: 'Bash(rm -f /tmp/x.txt)',
        sessionId: 'sess-1',
      },
    });

    assert.equal(children.length, 2, 'the child was NOT replaced — the grant never reached it');
    assert.ok(
      children[1]?.opts.grant?.allowed.includes('Bash(rm -f /tmp/x.txt)'),
      'the replacement child did not receive the granted command',
    );
  } finally {
    await sup.stop();
  }
});

/**
 * 🛑 A GRANT MUST NOT COST THE CHILD ITS MEMORY. Measured 2026-10-31:
 * `--resume` works 3 of 3 with the explicit prompt, so a permission round
 * trip is not a restart.
 */
test('the replacement RESUMES the session rather than starting a new one', async () => {
  const children: FakeChild[] = [];
  const sup = await supervisorFor(`rc-${process.pid}-b`, children);

  try {
    await deliverToSupervisor(`rc-${process.pid}-b`, {
      id: 2,
      to: `rc-${process.pid}-b`,
      from: 'lee',
      ts: Date.now(),
      approval: {
        approvalId: 2,
        decision: 'approve',
        requested: "rm in '/tmp/x.txt'",
        grant: 'Bash(rm -f /tmp/x.txt)',
        sessionId: 'x',
      },
    });

    assert.equal(children[1]?.opts.resumeSessionId, 'sess-from-fake');
  } finally {
    await sup.stop();
  }
});

/**
 * ⚠️ A grant is ADDITIVE. One that replaced the list would revoke everything
 * the agent already had, mid-task, and the symptom would be a second denial
 * for something that worked a minute earlier.
 */
test('a grant keeps every tool the child already had', async () => {
  const children: FakeChild[] = [];
  const sup = await supervisorFor(`rc-${process.pid}-c`, children);

  try {
    const before = [...(children[0]?.opts.grant?.allowed ?? [])];
    assert.ok(before.length > 0, 'the first child had no tools, so this proves nothing');

    await deliverToSupervisor(`rc-${process.pid}-c`, {
      id: 3,
      to: `rc-${process.pid}-c`,
      from: 'lee',
      ts: Date.now(),
      approval: {
        approvalId: 3,
        decision: 'approve',
        requested: "rm in '/tmp/x.txt'",
        grant: 'Bash(rm -f /tmp/x.txt)',
        sessionId: 'x',
      },
    });

    for (const tool of before) {
      assert.ok(children[1]?.opts.grant?.allowed.includes(tool), `the grant revoked: ${tool}`);
    }
  } finally {
    await sup.stop();
  }
});

/** A DENY must not replace anything — nothing changed, so nothing respawns. */
test('a DENY does not respawn the child', async () => {
  const children: FakeChild[] = [];
  const sup = await supervisorFor(`rc-${process.pid}-d`, children);

  try {
    await deliverToSupervisor(`rc-${process.pid}-d`, {
      id: 4,
      to: `rc-${process.pid}-d`,
      from: 'lee',
      ts: Date.now(),
      approval: {
        approvalId: 4,
        decision: 'deny',
        requested: "rm in '/tmp/x.txt'",
        grant: 'Bash(rm -f /tmp/x.txt)',
        sessionId: 'x',
      },
    });

    assert.equal(children.length, 1, 'a refusal replaced the child for no reason');
  } finally {
    await sup.stop();
  }
});

/**
 * 🛑 THE SEAM FOR A MODEL SWITCH, which lee asked to be easy to bolt on. A
 * switch is a CALLER of the same operation, so what this asserts is that the
 * operation carries `model` through at all.
 */
test('replaceChild carries a model change, so a switch is a caller not new machinery', () => {
  const src = readFileSync(new URL('../../src/supervise/index.ts', import.meta.url), 'utf8');

  assert.match(src, /allowedTools\?: readonly string\[\]; model\?: string/);
  assert.ok(src.includes('model: currentModel'), 'the replacement never passes a model');
});

/**
 * 🚨 EVERY REPLACEMENT CHILD HUNG, AND 245 TESTS WERE GREEN.
 *
 * `onTurnEnd` was registered OUTSIDE `wireChild()`, on the first child only.
 * A replacement's turn-complete signal reached nothing, the queue stayed
 * `inTurn` forever, and the supervisor looked idle rather than broken. The
 * approval path is the only caller, so it was the FIRST approval. Found by
 * claude1; the suite could not see it because the fake swallowed the
 * callback.
 */
test('the REPLACEMENT child can end a turn, or the queue waits forever', async () => {
  const children: FakeChild[] = [];
  const handle = `rc-${process.pid}-turn`;
  const sup = await supervisorFor(handle, children);

  try {
    await deliverToSupervisor(handle, {
      id: 10,
      to: handle,
      from: 'lee',
      ts: Date.now(),
      approval: {
        approvalId: 10,
        decision: 'approve',
        requested: "rm in '/tmp/x.txt'",
        grant: 'Bash(rm -f /tmp/x.txt)',
        sessionId: 'x',
      },
    });

    const replacement = children[1];
    assert.ok(replacement, 'no replacement child');

    // Its first prompt is the re-dispatch. Finish that turn, then a new
    // message must actually be delivered.
    replacement.finishTurn();

    await deliverToSupervisor(handle, {
      id: 11,
      to: handle,
      from: 'lee',
      ts: Date.now(),
      body: 'anything',
    });

    assert.ok(
      replacement.sent.length >= 2,
      `the replacement never received a second prompt — the queue is stuck (sent ${replacement.sent.length})`,
    );
  } finally {
    await sup.stop();
  }
});

/**
 * 🚨 THE DEAD CHILD'S onExit DRAINED THE LIVE QUEUE. `kill()` fires it after
 * the replacement is already running, so it threw away the carried-over work
 * AND reset the queue to idle mid-turn — two turns in flight at once. Found
 * by claude1.
 */
test("the old child's exit does not drain the NEW child's PENDING queue", async () => {
  const children: FakeChild[] = [];
  const handle = `rc-${process.pid}-exit`;
  const sup = await supervisorFor(handle, children);

  try {
    await deliverToSupervisor(handle, {
      id: 12,
      to: handle,
      from: 'lee',
      ts: Date.now(),
      approval: {
        approvalId: 12,
        decision: 'approve',
        requested: "rm in '/tmp/x.txt'",
        grant: 'Bash(rm -f /tmp/x.txt)',
        sessionId: 'x',
      },
    });

    const replacement = children[1];
    assert.ok(replacement, 'no replacement child');
    assert.equal(replacement.sent.length, 1, 'the re-dispatch prompt was not sent');

    // 🛑 QUEUE WORK WHILE THE REPLACEMENT IS MID-TURN. This is the state the
    // bug destroys: the dead child's exit drains a queue that belongs to the
    // live child. An earlier version of this test fired the stale exit with
    // NOTHING pending, so it passed with the guard removed — vacuous.
    await deliverToSupervisor(handle, {
      id: 13,
      to: handle,
      from: 'lee',
      ts: Date.now(),
      body: 'queued while busy',
    });

    assert.equal(replacement.sent.length, 1, 'the second prompt should still be QUEUED');

    // The dead child's kill signal lands late.
    children[0]?.exit();

    // The replacement finishes its turn; the queued prompt must now go out.
    replacement.finishTurn();

    assert.equal(
      replacement.sent.length,
      2,
      "the dead child's exit drained the live queue and the pending prompt was lost",
    );
  } finally {
    await sup.stop();
  }
});

/**
 * 🛑 THE SHAPE, NOT FOUR SEPARATE CHECKS.
 *
 * The first fix guarded `onExit` alone. claude1 pointed out that is one of
 * four, and that `onTurnEnd` had `generation` in scope two lines above and
 * did not use it. A stale turn-end releases the queue into a child that is
 * mid-turn; a stale denial files a SECOND approval for the command lee just
 * granted.
 *
 * A per-call check is something to forget. This asserts the wrapper instead.
 */
test('EVERY child callback registration goes through the generation guard', () => {
  const src = readFileSync(new URL('../../src/supervise/index.ts', import.meta.url), 'utf8');

  const body = src.slice(src.indexOf('function wireChild()'), src.indexOf('const replaceChild'));
  assert.ok(body.length > 0, 'wireChild moved; this check is stale');

  const registrations = [...body.matchAll(/child\.(on[A-Za-z]+)\(\s*([\s\S]{0,30})/g)];

  // 🛑 THE NAME SET, NOT A COUNT. An earlier version asserted
  // `length >= 4` with five present, so DELETING one stayed green — and the
  // original bug was `onTurnEnd` being ABSENT, not unwrapped. "Every
  // registration present is wrapped" is a different property from "every
  // required callback is registered". Raised by claude1.
  const REQUIRED = ['onTurnEnd', 'onSession', 'onDenial', 'onUsage', 'onExit'];
  const present = registrations.map(([, name]) => name);

  assert.deepEqual(
    [...present].sort(),
    [...REQUIRED].sort(),
    'a required callback is missing, or an unexpected one was added',
  );

  const unguarded = registrations
    .filter(([, , next]) => !next.includes('ifCurrent'))
    .map(([, name]) => name);

  assert.deepEqual(
    unguarded,
    [],
    `these act on the LIVE child after being replaced: ${unguarded.join(', ')}`,
  );

  // ⚠️ THE LABEL IS A HAND-WRITTEN DUPLICATE OF THE METHOD NAME, so
  // `ifCurrent('onUsage', …)` inside `child.onDenial(…)` would log the wrong
  // callback — and the log is the only trace a stale signal leaves. Raised
  // by claude1 as optional; it is three lines. The regex already captured
  // both halves.
  const mislabelled = registrations
    .filter(([, name, next]) => !next.includes(`'${name}'`))
    .map(([, name]) => name);

  assert.deepEqual(mislabelled, [], `these log under the wrong name: ${mislabelled.join(', ')}`);
});

/**
 * 🚨 A STALE TURN-END RUNS TWO TURNS AT ONCE. The replaced child's signal
 * releases the queue into a child that is still mid-turn.
 */
test("the old child's turn-end does not release the NEW child's queue", async () => {
  const children: FakeChild[] = [];
  const handle = `rc-${process.pid}-stale-turn`;
  const sup = await supervisorFor(handle, children);

  try {
    await deliverToSupervisor(handle, {
      id: 20,
      to: handle,
      from: 'lee',
      ts: Date.now(),
      approval: {
        approvalId: 20,
        decision: 'approve',
        requested: "rm in '/tmp/x.txt'",
        grant: 'Bash(rm -f /tmp/x.txt)',
        sessionId: 'x',
      },
    });

    const replacement = children[1];
    assert.ok(replacement, 'no replacement child');
    assert.equal(replacement.sent.length, 1, 'the re-dispatch prompt was not sent');

    await deliverToSupervisor(handle, {
      id: 21,
      to: handle,
      from: 'lee',
      ts: Date.now(),
      body: 'queued while busy',
    });

    assert.equal(replacement.sent.length, 1, 'the second prompt should still be QUEUED');

    // The DEAD child finishes its turn, late.
    children[0]?.finishTurn();

    assert.equal(
      replacement.sent.length,
      1,
      'a stale turn-end released the queue into a child that is mid-turn',
    );
  } finally {
    await sup.stop();
  }
});
