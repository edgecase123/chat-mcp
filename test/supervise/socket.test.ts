import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Point CHAT_MCP_HOME at a scratch dir BEFORE importing anything that reads it.
process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), 'chat-mcp-sock-'));

const { WakeListener, deliverToSupervisor } = await import('../../src/supervise/socket.js');
const { socketPathFor, socketDir, SOCKET_MODE, SOCKET_DIR_MODE } = await import(
  '../../src/util/paths.js'
);

const env = (id: number, body = 'hello') => ({ id, to: 'claude2', from: 'claude1', ts: 1, body });

test('with NO supervisor listening, delivery returns null rather than throwing', async () => {
  // Null means "fall back to the notify file", never "the send failed".
  assert.equal(await deliverToSupervisor('nobody-home', env(1)), null);
});

test('a listening supervisor receives the envelope AND the body', async () => {
  const seen: unknown[] = [];
  const l = await WakeListener.bind('recv', (e) => {
    seen.push(e);

    return { ok: true, queued: 'sent' };
  });

  try {
    const ack = await deliverToSupervisor('recv', env(42, 'the payload'));

    assert.deepEqual(ack, { ok: true, queued: 'sent' });
    // 🛑 The whole point over a file watch: the MESSAGE is in the event, so
    // the receiver never re-reads the database to find out what happened.
    assert.equal((seen[0] as { body: string }).body, 'the payload');
    assert.equal(seen.length, 1);
  } finally {
    await l.close();
  }
});

test('ten back-to-back deliveries all arrive — the file watch dropped 8 of 10', async () => {
  const seen: number[] = [];
  const l = await WakeListener.bind('burst', (e) => {
    seen.push(e.id);

    return { ok: true };
  });

  try {
    for (let i = 1; i <= 10; i++) {
      const ack = await deliverToSupervisor('burst', env(i));
      assert.equal(ack?.ok, true, `delivery ${i} was not acked`);
    }

    assert.deepEqual(seen, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  } finally {
    await l.close();
  }
});

test('the ack carries the queue decision back to the sender', async () => {
  const l = await WakeListener.bind('acks', () => ({ ok: true, queued: 'duplicate' }));

  try {
    assert.equal((await deliverToSupervisor('acks', env(5)))?.queued, 'duplicate');
  } finally {
    await l.close();
  }
});

test('a malformed line is still ACKED, so the sender does not wait out the timeout', async () => {
  const l = await WakeListener.bind('bad', () => ({ ok: true }));

  try {
    const { connect } = await import('node:net');
    const reply = await new Promise<string>((resolve) => {
      const s = connect(socketPathFor('bad'));
      s.setEncoding('utf8');
      s.on('connect', () => s.write('{ not json\n'));
      s.on('data', (d: string) => {
        resolve(d);
        s.destroy();
      });
    });

    const ack = JSON.parse(reply) as { ok: boolean; error?: string };
    assert.equal(ack.ok, false);
    assert.ok(ack.error, 'a refusal must say why');
  } finally {
    await l.close();
  }
});

test('an envelope missing its id is refused rather than passed on', async () => {
  let delivered = 0;
  const l = await WakeListener.bind('shape', () => {
    delivered++;

    return { ok: true };
  });

  try {
    const { connect } = await import('node:net');
    const reply = await new Promise<string>((resolve) => {
      const s = connect(socketPathFor('shape'));
      s.setEncoding('utf8');
      s.on('connect', () => s.write(`${JSON.stringify({ to: 'claude2' })}\n`));
      s.on('data', (d: string) => {
        resolve(d);
        s.destroy();
      });
    });

    assert.equal((JSON.parse(reply) as { ok: boolean }).ok, false);
    assert.equal(delivered, 0, 'a malformed envelope must not reach the handler');
  } finally {
    await l.close();
  }
});

test('a STALE socket file is debris and gets rebound', async () => {
  // A crashed supervisor leaves the file behind. listen() would fail EADDRINUSE.
  const path = socketPathFor('stale');
  writeFileSync(path, 'not a socket');
  assert.ok(existsSync(path));

  const l = await WakeListener.bind('stale', () => ({ ok: true }));

  try {
    assert.equal((await deliverToSupervisor('stale', env(1)))?.ok, true);
  } finally {
    await l.close();
  }
});

test('a LIVE rival is refused — two supervisors must not split one handle', async () => {
  const first = await WakeListener.bind('rival', () => ({ ok: true }));

  try {
    await assert.rejects(
      () => WakeListener.bind('rival', () => ({ ok: true })),
      /already listening/,
    );
  } finally {
    await first.close();
  }
});

test('closing removes the socket file, so the next bind sees no rival', async () => {
  const l = await WakeListener.bind('cleanup', () => ({ ok: true }));
  const path = l.socketPath;
  assert.ok(existsSync(path));

  await l.close();

  assert.equal(existsSync(path), false);
});

test('close() resolves even while a sender holds its connection open', async () => {
  // 🛑 This test exists because a negative control PASSED without it. Removing
  // the connection-drain from close() broke nothing, which means the fix was
  // unpinned — and its failure mode is a HANG, which node:test reports as
  // `cancelled`, not `fail`. A reader checking only `fail` sees green.
  const l = await WakeListener.bind('lingering', () => ({ ok: true }));
  const { connect } = await import('node:net');

  // Connect and deliberately stay connected, the way a long-lived supervisor
  // client would.
  const held = connect(l.socketPath);
  await new Promise<void>((r) => held.once('connect', () => r()));

  const closed = await Promise.race([
    l.close().then(() => 'closed' as const),
    new Promise<'hung'>((r) => setTimeout(() => r('hung'), 3_000)),
  ]);

  held.destroy();

  assert.equal(closed, 'closed', 'close() hung while a connection was open');
});

test('a supervisor that never answers times out instead of blocking the sender', async () => {
  // Bind by hand and answer nothing at all.
  const { createServer } = await import('node:net');
  const path = socketPathFor('silent');
  const held: import('node:net').Socket[] = [];
  const server = createServer((s) => {
    held.push(s); // must be destroyed, or server.close() waits forever
  });
  await new Promise<void>((r) => server.listen(path, () => r()));

  try {
    const started = Date.now();
    const ack = await deliverToSupervisor('silent', env(1), 300);

    assert.equal(ack, null, 'a silent supervisor must read as no supervisor');
    assert.ok(Date.now() - started < 2_000, 'the sender must not hang');
  } finally {
    for (const s of held) s.destroy();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

// ── the socket's permissions ────────────────────────────────────────────

const modeOf = (p: string) => statSync(p).mode & 0o777;

/**
 * 🛑 A PERMISSIVE UMASK IS THE WHOLE POINT OF THIS FIXTURE.
 *
 * Until this guard existed, the socket's mode came from the launching
 * shell's umask and nothing in the code set it. Under the usual 022 it
 * happened to be 755, which is why nobody noticed. Binding under 000 is what
 * makes the difference between "the code sets it" and "the environment did"
 * visible at all.
 */
test('🚨 the socket is 0600 even when the umask would have made it 0777', async () => {
  const prev = process.umask(0o000);
  try {
    const l = await WakeListener.bind('perms', () => ({ ok: true, queued: 'sent' }));
    try {
      assert.equal(modeOf(socketPathFor('perms')), SOCKET_MODE);
    } finally {
      await l.close();
    }
  } finally {
    process.umask(prev);
  }
});

/**
 * 🛑 THE NEGATIVE CONTROL. Without it, a 0600 socket proves nothing — a
 * restrictive umask in whatever runs this suite would produce the same
 * number with the chmod deleted. This binds a PLAIN socket in the same
 * directory under the same umask and shows it comes out wide open.
 */
test('a plain socket in the same dir under the same umask is 0777, so the fixture discriminates', async () => {
  const prev = process.umask(0o000);
  const path = join(socketDir(), 'control');
  try {
    const srv = createServer();
    await new Promise<void>((res) => srv.listen(path, res));
    try {
      assert.equal(modeOf(path), 0o777, 'the umask really is permissive here');
    } finally {
      await new Promise<void>((res) => srv.close(() => res()));
    }
  } finally {
    process.umask(prev);
  }
});

/**
 * 🛑 THE DIRECTORY IS THE RACE-CLOSER. `listen()` creates the socket at the
 * umask mode and the chmod can only follow it. A 0700 directory denies
 * traversal for the whole of that window, so it is the control that actually
 * holds, and the socket's own mode is the second layer.
 */
test('🚨 the socket DIRECTORY is 0700, which is what covers the window before the chmod', async () => {
  const prev = process.umask(0o000);
  try {
    const l = await WakeListener.bind('perms-dir', () => ({ ok: true, queued: 'sent' }));
    try {
      assert.equal(modeOf(socketDir()), SOCKET_DIR_MODE);
    } finally {
      await l.close();
    }
  } finally {
    process.umask(prev);
  }
});

/** ⚠️ An ALREADY EXISTING directory keeps its old mode — mkdir does not fix
 *  one it did not create, so an existing install must be repaired too. */
test('a socket dir that already exists wide open is tightened, not left alone', async () => {
  const { chmodSync, mkdirSync } = await import('node:fs');
  const { ensureSocketDir } = await import('../../src/util/paths.js');
  mkdirSync(socketDir(), { recursive: true });
  chmodSync(socketDir(), 0o777);
  assert.equal(modeOf(socketDir()), 0o777, 'the fixture is actually wide open before the call');
  ensureSocketDir();
  assert.equal(modeOf(socketDir()), SOCKET_DIR_MODE);
});

/**
 * 🚨 THE ARC GAP. A supervised child is registered on the bus as
 * `<handle>-agent` and the supervisor binds `<handle>`, deliberately — a child
 * sharing the supervisor's handle eats the deliveries meant for it (#35). On
 * the HOST that is fine, because the child's own shim watches
 * `notify/<handle>-agent`.
 *
 * 🛑 A CONTAINERIZED CHILD WATCHES NO NOTIFY FILE. The state dir is not
 * mounted, so the supervisor socket is its ONLY wake path — and every message
 * is addressed to the child handle, which had no socket. `deliverToSupervisor`
 * returned null and the message was dropped with no error anywhere.
 *
 * Measured against a live container: the supervisor log never moved.
 */
test('🚨 a message addressed to the CHILD handle reaches its supervisor', async () => {
  const seen: unknown[] = [];
  const l = await WakeListener.bind('boxed', (e) => {
    seen.push(e);

    return { ok: true, queued: 'sent' };
  });

  try {
    const ack = await deliverToSupervisor('boxed-agent', env(7, 'for the child'));

    assert.deepEqual(ack, { ok: true, queued: 'sent' }, 'the child handle reached no supervisor');
    assert.equal((seen[0] as { body: string }).body, 'for the child');
  } finally {
    await l.close();
  }
});

/**
 * 🛑 THE PAIRED CONTROL. The fallback must not invent a supervisor: a child
 * handle whose supervisor is not listening still falls back to the notify
 * file, exactly as an unknown handle does.
 */
test('🚨 a child handle with NO supervisor listening still returns null', async () => {
  assert.equal(await deliverToSupervisor('unsupervised-agent', env(8)), null);
});
