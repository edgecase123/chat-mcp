import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 🛑 BEFORE any import that resolves a state path, or the supervisor binds a
// socket inside the OPERATOR'S LIVE ~/.chat-mcp.
//
// ⚠️ THE PREFIX AND THE HANDLES BELOW ARE SHORT ON PURPOSE. A unix socket path
// is capped at 104 bytes on macOS, and `<tmpdir>/<prefix><6>/sock/<handle>`
// sat exactly on the edge: this file passed alone and failed `listen` with
// EINVAL under the full suite, where the pid is one digit longer.
process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), 'cm-ex-'));

const { migrate } = await import('../../src/storage/db.js');
const { startSupervisor } = await import('../../src/supervise/index.js');
const { deliverToSupervisor } = await import('../../src/supervise/socket.js');
const { claudeSpawn } = await import('../../src/adapters/claude-spawn.js');
import type { AgentChild, SpawnOptions } from '../../src/supervise/child.js';

/**
 * 🛑 A SUPERVISOR WHOSE CHILD HAS EXITED STILL ANSWERS `queued: 'sent'`.
 *
 * `onWake` has two refusal guards, `supervisor is still starting` and
 * `supervisor is stopping`, and a child that exits on its own trips neither.
 * `onExit` drains the queue, which leaves `state = 'idle'`, so the next
 * `offer` takes the idle branch, writes to the dead process and reports
 * `sent`. The sender is told its work was handed over.
 *
 * lee ruled on 2026-11-14: close the socket on child death. A delivery then
 * returns `null`, which is what every caller already reads as "no supervisor".
 *
 * ⚠️ THE SECOND TEST IS THE CONTROL, AND IT IS THE REASON THE CLOSE GOES
 * INSIDE `ifCurrent`. A replace kills the child, so its exit arrives after the
 * generation has moved. Closing on that exit would tear down the socket of a
 * supervisor whose new child is already running.
 */

interface FakeChild {
  readonly sent: string[];
  fireExit: () => void;
}

/**
 * A child whose teardown the test controls, so a stop can be inspected while
 * it is still in progress.
 */
interface TeardownChild extends FakeChild {
  finishTeardown: () => void;
}

/** `kill()` fires no exit, like the real thing — the exit is a later event. */
function recordingChild(children: FakeChild[]) {
  return (_opts: SpawnOptions): AgentChild => {
    const sent: string[] = [];
    let onExit: ((c: number | null, s: string | null) => void) | undefined;

    children.push({
      sent,
      fireExit: () => onExit?.(243, null),
    });

    return {
      reportsUsage: false,
      reportsContext: true,
      send: (t) => sent.push(t),
      onTurnEnd: () => undefined,
      onContext: () => undefined,
      onUsage: () => undefined,
      onDenial: () => undefined,
      onSession: (cb) => cb('sess-from-fake'),
      onEvent: () => undefined,
      onStderr: () => undefined,
      onExit: (cb) => {
        onExit = cb;
      },
      kill: () => undefined,
    };
  };
}

async function supervisorFor(handle: string, children: FakeChild[]) {
  const db = new DatabaseSync(':memory:');
  migrate(db);

  const sup = await startSupervisor({
    handle,
    vendor: claudeSpawn,
    db,
    extraDirs: [process.cwd()],
    spawnChild: recordingChild(children),
    log: () => undefined,
  });

  return { sup, db };
}

async function deliver(handle: string, id: number, rest: Record<string, unknown>) {
  return deliverToSupervisor(handle, {
    id,
    to: handle,
    from: 'lee',
    ts: Date.now(),
    ...rest,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
}

test('🚨 a child that exits on its own closes the wake socket, so a later send is not acked as delivered', async () => {
  const children: FakeChild[] = [];
  const handle = `xo${process.pid}`;
  const { sup, db } = await supervisorFor(handle, children);

  try {
    const before = await deliver(handle, 1, { body: 'reaches a live child' });
    assert.equal(before?.queued, 'sent', 'the live child never got the first prompt');
    assert.equal(children[0]?.sent.length, 1);

    children[0]!.fireExit();

    const after = await deliver(handle, 2, { body: 'NOBODY IS RUNNING TO READ THIS' });

    assert.equal(
      after,
      null,
      'the socket outlived the child, so the sender was told its work was handed over',
    );
    assert.equal(
      children[0]?.sent.length,
      1,
      'the supervisor wrote a second prompt to a process that had exited',
    );
  } finally {
    await sup.stop('now').catch(() => undefined);
    db.close();
  }
});

test('a STALE exit from a replaced child leaves the socket open, because the new child is live', async () => {
  const children: FakeChild[] = [];
  const handle = `xs${process.pid}`;
  const { sup, db } = await supervisorFor(handle, children);

  try {
    await deliver(handle, 1, { body: 'so the first child exists' });

    await deliver(handle, 2, {
      approval: {
        approvalId: 1,
        decision: 'approve',
        requested: "rm in '/tmp/x.txt'",
        grant: 'Bash(rm -f /tmp/x.txt)',
        sessionId: 'sess-1',
      },
    });

    assert.equal(children.length, 2, 'the approval was supposed to replace the child');

    // The killed child really does exit, and it arrives after the generation
    // moved. This is the signal that must NOT take the socket down.
    children[0]!.fireExit();

    const after = await deliver(handle, 3, { body: 'the new child must still receive this' });

    // 🛑 `ok`, NOT `queued: 'sent'`. The replacement's own explaining prompt
    // puts the new child mid-turn, so this one is legitimately QUEUED. The
    // claim here is that the socket answered at all.
    assert.notEqual(after, null, 'a stale exit closed the socket of a live supervisor');
    assert.equal(after?.ok, true, 'the supervisor refused a wake while its new child was live');
  } finally {
    await sup.stop('now').catch(() => undefined);
    db.close();
  }
});


/**
 * 🛑 THE CONTROL FOR THE `hasStopped` HALF OF THE GUARD. Without it the whole
 * suite still passed, which means nothing could have said no.
 *
 * `doStop` kills the child WITHOUT moving the generation, so that exit is
 * current and this handler runs. `doStop` then waits for the teardown and
 * closes the socket itself, deliberately after it — `agents stop` has no other
 * signal that a host child is really gone. An early close moves that signal.
 */
test('🚨 a stop does not let the child exit close the socket before the teardown finishes', async () => {
  const children: TeardownChild[] = [];
  const handle = `xt${process.pid}`;
  const db = new DatabaseSync(':memory:');
  migrate(db);

  let releaseTeardown: (() => void) | undefined;

  const sup = await startSupervisor({
    handle,
    vendor: claudeSpawn,
    db,
    extraDirs: [process.cwd()],
    spawnChild: (_opts: SpawnOptions): AgentChild => {
      const sent: string[] = [];
      let onExit: ((c: number | null, s: string | null) => void) | undefined;
      const teardown = new Promise<void>((resolve) => {
        releaseTeardown = resolve;
      });

      children.push({
        sent,
        fireExit: () => onExit?.(0, 'SIGTERM'),
        finishTeardown: () => releaseTeardown?.(),
      });

      return {
        reportsUsage: false,
        reportsContext: true,
        send: (t) => sent.push(t),
        onTurnEnd: () => undefined,
        onContext: () => undefined,
        onUsage: () => undefined,
        onDenial: () => undefined,
        onSession: (cb) => cb('sess-from-fake'),
        onEvent: () => undefined,
        onStderr: () => undefined,
        onExit: (cb) => {
          onExit = cb;
        },
        kill: () => undefined,
        awaitTeardown: () => teardown,
      };
    },
    log: () => undefined,
  });

  try {
    const socketPath = sup.socketPath;
    assert.ok(existsSync(socketPath), 'the supervisor never bound its socket');

    const stopping = sup.stop('now');

    // The killed child really does exit, and a stop never moved the
    // generation, so this reaches the handler.
    children[0]!.fireExit();
    await Promise.resolve();

    assert.ok(
      existsSync(socketPath),
      'the child exit closed the socket while the teardown was still running, so a stop reports done early',
    );

    children[0]!.finishTeardown();
    await stopping;

    assert.equal(existsSync(socketPath), false, 'the stop left its socket behind');
  } finally {
    children[0]?.finishTeardown();
    await sup.stop('now').catch(() => undefined);
    db.close();
  }
});
