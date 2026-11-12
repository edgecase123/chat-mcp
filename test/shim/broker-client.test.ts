import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 🛑 BEFORE any import that resolves a state path.
process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), 'chat-mcp-client-'));

const { CommandBroker } = await import('../../src/supervise/broker.js');
const { registerProject } = await import('../../src/supervise/projects.js');
const { ensureManifestDir, manifestPathFor } = await import('../../src/util/paths.js');
const { askBroker, brokerAddress, CLOSED_SILENTLY, REFUSED, TIMED_OUT } = await import(
  '../../src/shim/broker-client.js'
);

type Broker = Awaited<ReturnType<typeof CommandBroker.bind>>;

const TOKEN = 'tok-secret';

const MANIFEST = {
  commands: [
    {
      name: 'gate',
      script: 'scripts/gate.sh',
      params: [{ name: 'lane', type: 'enum', values: ['php', 'js'] }],
    },
  ],
};

/** A project directory with one runnable script, plus its manifest in the store. */
function brokerFor(handle: string): Promise<Broker> {
  const dir = mkdtempSync(join(tmpdir(), 'chat-mcp-client-project-'));

  mkdirSync(join(dir, 'scripts'), { recursive: true });
  const script = join(dir, 'scripts', 'gate.sh');
  // `resolveArgv` passes the declared params as bare VALUES in order, so the
  // first positional is `lane`. Echoing `$*` too, so a shape change shows up
  // here as a readable diff rather than an empty string.
  writeFileSync(script, '#!/bin/sh\necho "lane=$1 argv=$*"\n');
  chmodSync(script, 0o755);

  registerProject(handle, dir);
  ensureManifestDir();
  writeFileSync(manifestPathFor(handle), JSON.stringify({ projectDir: dir, ...MANIFEST }));

  return CommandBroker.bind({ authenticate: (t) => (t === TOKEN ? handle : null) });
}

const handleFor = (name: string) => `${name}-${process.pid}`;

// ---------------------------------------------------------------------------
// brokerAddress — a capability check, not an error path
// ---------------------------------------------------------------------------

test('🛑 NO BROKER IS THE NORMAL CASE — both vars absent reads as null', () => {
  assert.equal(brokerAddress({}), null);
});

test('a token with no port reads as null, and a port with no token reads as null', () => {
  assert.equal(brokerAddress({ CHAT_MCP_BROKER_TOKEN: TOKEN }), null);
  assert.equal(brokerAddress({ CHAT_MCP_BROKER_PORT: '4000' }), null);
});

test('🛑 AN UNUSABLE PORT IS ABSENCE, NOT A FAULT — there is no broker either way', () => {
  for (const port of ['', 'zero', '0', '-1', '65536', '8080.5']) {
    assert.equal(
      brokerAddress({ CHAT_MCP_BROKER_PORT: port, CHAT_MCP_BROKER_TOKEN: TOKEN }),
      null,
      `port ${JSON.stringify(port)} should read as no broker`,
    );
  }
});

test('⚠️ control — a usable pair DOES read as a broker', () => {
  // Without this, a brokerAddress that returned null for everything would pass
  // every assertion above.
  assert.deepEqual(
    brokerAddress({ CHAT_MCP_BROKER_PORT: '4000', CHAT_MCP_BROKER_TOKEN: TOKEN }),
    { port: 4000, token: TOKEN },
  );
});

// ---------------------------------------------------------------------------
// askBroker — against a REAL CommandBroker, never a mocked protocol
// ---------------------------------------------------------------------------

test('⚠️ CONTROL — a valid token lists the commands the manifest declares', async (t) => {
  // The positive half of every refusal test below. A client that failed on
  // everything would pass all of them and prove nothing.
  const broker = await brokerFor(handleFor('ok'));
  t.after(() => broker.close());

  const reply = await askBroker('list-commands', {}, {
    address: { port: broker.port, token: TOKEN },
  });

  assert.deepEqual(reply.commands, [
    { name: 'gate', params: [{ name: 'lane', type: 'enum', values: ['php', 'js'] }] },
  ]);
});

test('a run-command reply carries the script exit code and output', async (t) => {
  const broker = await brokerFor(handleFor('run'));
  t.after(() => broker.close());

  const reply = await askBroker('run-command', { name: 'gate', params: { lane: 'php' } }, {
    address: { port: broker.port, token: TOKEN },
  });

  assert.equal(reply.exitCode, 0);
  assert.match(String(reply.stdout), /lane=php/);
});

test('🛑 A WRONG TOKEN CLOSES THE SOCKET WITH NO REPLY, and that is reported as a cause', async (t) => {
  // The branch a client that only handles `ok: false` hangs on. The broker
  // answers six classes of bad request with nothing at all, and every one of
  // them arrives as a close.
  const broker = await brokerFor(handleFor('wrong'));
  t.after(() => broker.close());

  await assert.rejects(
    askBroker('list-commands', {}, {
      address: { port: broker.port, token: 'not-the-token' },
      deadlineMs: 5_000,
    }),
    // Asserting the message, not merely "it rejected" — a rejection on any
    // other cause, including a client bug, would pass the weaker predicate.
    (err: Error) => err.message === CLOSED_SILENTLY,
  );
});

test('🛑 THE REFUSAL ARRIVES AS A CLOSE, NOT AS THE DEADLINE ELAPSING', async (t) => {
  // A deadline-shaped failure would also satisfy the test above, so the cost is
  // asserted separately: the answer comes back in well under the deadline.
  const broker = await brokerFor(handleFor('fast'));
  t.after(() => broker.close());

  const started = Date.now();

  await assert.rejects(
    askBroker('list-commands', {}, {
      address: { port: broker.port, token: 'not-the-token' },
      deadlineMs: 30_000,
    }),
  );

  assert.ok(
    Date.now() - started < 5_000,
    `the refusal took ${Date.now() - started}ms, which means it waited for the deadline`,
  );
});

test("the broker's own refusal sentence is passed through verbatim", async (t) => {
  const broker = await brokerFor(handleFor('unknown'));
  t.after(() => broker.close());

  await assert.rejects(
    askBroker('no-such-op', {}, { address: { port: broker.port, token: TOKEN } }),
    (err: Error) => err.message === 'unknown op',
  );
});

test('nothing listening on the port reads as a refused connection', async (t) => {
  // Bound, then closed, so the port is one the OS really has nobody on.
  const broker = await brokerFor(handleFor('closed'));
  const { port } = broker;
  await broker.close();
  t.after(() => undefined);

  await assert.rejects(
    askBroker('list-commands', {}, { address: { port, token: TOKEN }, deadlineMs: 5_000 }),
    (err: Error) => err.message === REFUSED,
  );
});

test('🛑 A PEER THAT DRIBBLES UNMATCHED LINES STILL HITS THE DEADLINE', async (t) => {
  // The bug claude1 found: `socket.setTimeout` is an IDLE timeout, so any byte
  // from the peer resets it and the call never ends. This server answers, but
  // never with our id, forever.
  const { createServer } = await import('node:net');
  const noise = createServer((socket) => {
    const tick = setInterval(() => socket.write(`${JSON.stringify({ id: -1, ok: true })}\n`), 50);
    socket.on('close', () => clearInterval(tick));
    socket.on('error', () => clearInterval(tick));
  });

  await new Promise<void>((resolve) => noise.listen(0, '127.0.0.1', () => resolve()));
  const { port } = noise.address() as { port: number };
  t.after(() => new Promise<void>((resolve) => noise.close(() => resolve())));

  const started = Date.now();

  await assert.rejects(
    askBroker('list-commands', {}, {
      address: { port, token: TOKEN },
      deadlineMs: 400,
    }),
    // Named, because "it rejected" would also pass on a client that crashed.
    (err: Error) => err.message === TIMED_OUT,
  );

  const elapsed = Date.now() - started;

  assert.ok(elapsed < 3_000, `took ${elapsed}ms, so the deadline was being reset by the writes`);
});
