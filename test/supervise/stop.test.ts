import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), 'chat-mcp-stop-'));

const { migrate } = await import('../../src/storage/db.js');
const { startSupervisor } = await import('../../src/supervise/index.js');
const { deliverToSupervisor } = await import('../../src/supervise/socket.js');

const DIRS = [process.cwd()];

interface FakeChild {
  sent: string[];
  killed: boolean;
  finishTurn: () => void;
  /** Resolve this child's `awaitTeardown()`, standing in for `docker stop`. */
  finishTeardown: () => void;
  teardownAwaited: boolean;
}

function recordingChild(children: FakeChild[]) {
  return () => {
    const sent: string[] = [];
    let endTurn: (() => void) | undefined;
    let releaseTeardown: (() => void) | undefined;
    const rec: FakeChild = {
      sent,
      killed: false,
      finishTurn: () => endTurn?.(),
      finishTeardown: () => releaseTeardown?.(),
      teardownAwaited: false,
    };
    children.push(rec);

    return {
      reportsUsage: false,
      send: (t: string) => sent.push(t),
      onTurnEnd: (cb: () => void) => {
        endTurn = cb;
      },
      onUsage: () => undefined,
      onDenial: () => undefined,
      onSession: (cb: (id: string) => void) => cb('sess-1'),
      onEvent: () => undefined,
      onExit: () => undefined,
      kill: () => {
        rec.killed = true;
      },
      awaitTeardown: () => {
        rec.teardownAwaited = true;

        return new Promise<void>((resolve) => {
          releaseTeardown = resolve;
        });
      },
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

async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 50));
}

test('a stop control kills the child without respawning it', async () => {
  const children: FakeChild[] = [];
  const handle = `stop-${process.pid}-now`;
  const sup = await supervisorFor(handle, children);

  try {
    const ack = await deliverToSupervisor(handle, {
      id: 1,
      to: handle,
      from: 'cli',
      ts: Date.now(),
      control: { kind: 'stop', mode: 'now' },
    });

    assert.equal(ack?.ok, true);
    await settle();

    // The COUNT is the assertion, not the kill flag. A stop that respawns also
    // kills, so asserting `killed` alone passes on a restart.
    assert.equal(children.length, 1);
    assert.equal(children[0].killed, true);
    assert.equal(children[0].sent.length, 0);
  } finally {
    children[0]?.finishTeardown();
    await sup.stop('now');
  }
});

test('a graceful stop warns the child before killing it', async () => {
  const children: FakeChild[] = [];
  const handle = `stop-${process.pid}-graceful`;
  const sup = await supervisorFor(handle, children);

  try {
    const ack = await deliverToSupervisor(handle, {
      id: 2,
      to: handle,
      from: 'cli',
      ts: Date.now(),
      control: { kind: 'stop', mode: 'graceful' },
    });

    assert.equal(ack?.ok, true);
    await settle();

    assert.equal(children.length, 1);
    assert.equal(children[0].sent.length, 1);
    assert.match(children[0].sent[0], /externaliz/i);
    assert.equal(children[0].killed, false);

    children[0].finishTurn();
    await settle();

    assert.equal(children[0].killed, true);
    assert.equal(children.length, 1);
  } finally {
    children[0]?.finishTeardown();
    await sup.stop('now');
  }
});

test('onStopped waits for the teardown rather than firing on the kill', async () => {
  const children: FakeChild[] = [];
  const handle = `stop-${process.pid}-cb`;
  const sup = await supervisorFor(handle, children);

  try {
    let stopped = 0;
    sup.onStopped(() => {
      stopped += 1;
    });

    await deliverToSupervisor(handle, {
      id: 3,
      to: handle,
      from: 'cli',
      ts: Date.now(),
      control: { kind: 'stop', mode: 'now' },
    });

    await settle();

    // 🛑 THE ASSERTION IS THE ZERO. `docker stop` runs detached, so firing the
    // exit hook on the kill reports "stopped" while the container is still up.
    assert.equal(children[0].killed, true);
    assert.equal(children[0].teardownAwaited, true);
    assert.equal(stopped, 0);

    children[0].finishTeardown();
    await settle();

    // The CLI's only exit signal. Without it the supervise process survives its
    // own stop and the operator sees nothing happen.
    assert.equal(stopped, 1);

    // The SIGINT handler still calls stop() after a bus stop has landed. That
    // second call must not fire the exit callback again.
    await sup.stop('now');
    assert.equal(stopped, 1);
  } finally {
    children[0]?.finishTeardown();
    await sup.stop('now');
  }
});

test('a wake arriving during the teardown is refused, not delivered', async () => {
  const children: FakeChild[] = [];
  const handle = `stop-${process.pid}-window`;
  const sup = await supervisorFor(handle, children);

  try {
    await deliverToSupervisor(handle, {
      id: 5,
      to: handle,
      from: 'cli',
      ts: Date.now(),
      control: { kind: 'stop', mode: 'now' },
    });

    await settle();

    // The socket outlives the child for up to the full grace period, so this
    // window is real and a sender in it must not be told `sent`.
    const late = await deliverToSupervisor(handle, {
      id: 6,
      to: handle,
      from: 'someone',
      ts: Date.now(),
      body: 'hello?',
    });

    assert.equal(late?.ok, false);
    assert.equal(children[0].sent.length, 0);
  } finally {
    children[0]?.finishTeardown();
    await sup.stop('now');
  }
});

test('a driver with no awaitTeardown still stops', async () => {
  const children: FakeChild[] = [];
  const handle = `stop-${process.pid}-no-teardown`;
  const db = new DatabaseSync(':memory:');
  migrate(db);

  // The seam is optional by contract. A driver that omits it must not hang the
  // stop waiting for a hook that was never there.
  const sup = await startSupervisor({
    handle,
    db,
    extraDirs: DIRS,
    spawnChild: () => {
      const base = recordingChild(children)();

      return { ...base, awaitTeardown: undefined };
    },
    log: () => undefined,
  });

  let stopped = 0;
  sup.onStopped(() => {
    stopped += 1;
  });

  await deliverToSupervisor(handle, {
    id: 4,
    to: handle,
    from: 'cli',
    ts: Date.now(),
    control: { kind: 'stop', mode: 'now' },
  });

  await settle();

  assert.equal(children[0].killed, true);
  assert.equal(stopped, 1);
});
