import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), 'chat-mcp-restart-'));

const { migrate } = await import('../../src/storage/db.js');
const { startSupervisor } = await import('../../src/supervise/index.js');
const { deliverToSupervisor } = await import('../../src/supervise/socket.js');
import { supervisorOptions } from '../support/supervisor-options.js';

const DIRS = [process.cwd()];

interface FakeChild {
  readonly opts: { resumeSessionId?: string };
  sent: string[];
  killed: boolean;
  finishTurn: () => void;
}

function recordingChild(children: FakeChild[]) {
  return (opts: { resumeSessionId?: string }) => {
    const sent: string[] = [];
    let endTurn: (() => void) | undefined;
    const rec: FakeChild = { opts, sent, killed: false, finishTurn: () => endTurn?.() };
    children.push(rec);

    return {
      reportsUsage: false,
      reportsContext: true,
      send: (t: string) => sent.push(t),
      onTurnEnd: (cb: () => void) => {
        endTurn = cb;
      },
      onContext: () => undefined,
      onUsage: () => undefined,
      onDenial: () => undefined,
      onSession: (cb: (id: string) => void) => cb('sess-1'),
      onEvent: () => undefined,
      onExit: () => undefined,
      kill: () => {
        rec.killed = true;
      },
    };
  };
}

async function supervisorFor(handle: string, children: FakeChild[]) {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  return startSupervisor(supervisorOptions({
    handle,
    db,
    extraDirs: DIRS,
    spawnChild: recordingChild(children),
    log: () => undefined,
  }));
}

test('--now restarts immediately with no notice sent', async () => {
  const children: FakeChild[] = [];
  const handle = `restart-${process.pid}-now`;
  const sup = await supervisorFor(handle, children);

  try {
    const ack = await deliverToSupervisor(handle, {
      id: 1,
      to: handle,
      from: 'cli',
      ts: Date.now(),
      control: { kind: 'restart', mode: 'now' },
    });

    assert.equal(ack?.ok, true);
    assert.equal(children[0]?.killed, true);
    assert.equal(children.length, 2, 'no replacement child was spawned');
    assert.equal(children[1]?.sent.length, 0, 'an immediate restart must not send a notice');
  } finally {
    await sup.stop();
  }
});

test('graceful restart sends the externalize notice and waits for its reply before killing', async () => {
  const children: FakeChild[] = [];
  const handle = `restart-${process.pid}-graceful`;
  const sup = await supervisorFor(handle, children);

  try {
    const ackPromise = deliverToSupervisor(handle, {
      id: 2,
      to: handle,
      from: 'cli',
      ts: Date.now(),
      control: { kind: 'restart', mode: 'graceful' },
    });

    await ackPromise;

    assert.equal(children[0]?.sent.length, 1, 'the notice was never sent');
    assert.match(children[0]?.sent[0] ?? '', /restarting/i);
    assert.equal(children[0]?.killed, false, 'killed before the notice turn ended');

    children[0]?.finishTurn();

    await new Promise((r) => setTimeout(r, 10));

    assert.equal(children[0]?.killed, true, 'never killed after the notice turn ended');
    assert.equal(children.length, 2, 'no replacement child was spawned');
  } finally {
    await sup.stop();
  }
});

test('graceful restart requested mid-turn is NOT killed on the in-flight turn\'s own end', async () => {
  // 🛑 THE REGRESSION THIS GUARDS. A notice queued behind an in-flight turn
  // is dispatched BY the turn-end that flushes the queue — that same
  // turn-end event must not be mistaken for the notice's OWN reply, or the
  // child is killed the instant it receives the notice, with no turn to act
  // on it. Found by code review on the first implementation of this file.
  const children: FakeChild[] = [];
  const handle = `restart-${process.pid}-midturn`;
  const sup = await supervisorFor(handle, children);

  try {
    await deliverToSupervisor(handle, { id: 1, to: handle, from: 'lee', ts: Date.now(), body: 'already-in-flight' });
    assert.equal(children[0]?.sent.length, 1, 'the in-flight turn must have started');

    const ackPromise = deliverToSupervisor(handle, {
      id: 2,
      to: handle,
      from: 'cli',
      ts: Date.now(),
      control: { kind: 'restart', mode: 'graceful' },
    });
    await ackPromise;

    // The notice is only QUEUED while the prior turn is still open — not
    // dispatched yet, so no second `send` has happened.
    assert.equal(children[0]?.sent.length, 1, 'the notice must not jump the queue');

    // Ending the IN-FLIGHT turn flushes the notice into dispatch. This is
    // the turn-end the bug fired on incorrectly.
    children[0]?.finishTurn();
    await new Promise((r) => setTimeout(r, 10));

    assert.equal(children[0]?.sent.length, 2, 'the notice should now have been dispatched');
    assert.equal(children[0]?.killed, false, 'must not be killed on the SAME turn-end that dispatched the notice');

    // Ending the notice's OWN turn is the actual reply.
    children[0]?.finishTurn();
    await new Promise((r) => setTimeout(r, 10));

    assert.equal(children[0]?.killed, true, 'must be killed once the notice turn itself ends');
    assert.equal(children.length, 2, 'no replacement child was spawned');
  } finally {
    await sup.stop();
  }
});

test('a restarted child does NOT resume the old session — that is the clean slate', async () => {
  const children: FakeChild[] = [];
  const handle = `restart-${process.pid}-clean`;
  const sup = await supervisorFor(handle, children);

  try {
    await deliverToSupervisor(handle, {
      id: 3,
      to: handle,
      from: 'cli',
      ts: Date.now(),
      control: { kind: 'restart', mode: 'now' },
    });

    assert.equal(children.length, 2);
    assert.equal(children[1]?.opts.resumeSessionId, undefined, 'the replacement must not resume the old session');
  } finally {
    await sup.stop();
  }
});

test('restarting an unknown handle (no supervisor listening) returns null, not a hang', async () => {
  const ack = await deliverToSupervisor('nobody-home-restart', {
    id: 1,
    to: 'nobody-home-restart',
    from: 'cli',
    ts: Date.now(),
    control: { kind: 'restart', mode: 'now' },
  });

  assert.equal(ack, null);
});
