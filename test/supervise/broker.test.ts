import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 🛑 BEFORE any import that resolves a state path.
process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), 'chat-mcp-broker-'));

const { CommandBroker } = await import('../../src/supervise/broker.js');
const { dirsFor, registerProject } = await import('../../src/supervise/projects.js');
const { ensureManifestDir, manifestPathFor } = await import('../../src/util/paths.js');

type Broker = Awaited<ReturnType<typeof CommandBroker.bind>>;

/**
 * What each fixture directory declares, keyed by that directory.
 *
 * The manifest is no longer written inside the project, so the fixture holds it
 * until a handle is known and `installManifest` puts it in the store.
 */
const manifests = new Map<string, unknown>();

/** A project directory with the scripts its manifest names. */
function project(
  commands: unknown,
  scripts: Readonly<Record<string, string>> = {},
): string {
  const dir = mkdtempSync(join(tmpdir(), 'chat-mcp-project-'));

  // `projectDir` is required as of slice 3a. A non-object is left alone, so the
  // malformed-manifest cases still reach the parser as they were written.
  manifests.set(
    dir,
    typeof commands === 'object' && commands !== null && !Array.isArray(commands)
      ? { projectDir: dir, ...commands }
      : commands,
  );

  mkdirSync(join(dir, 'scripts'), { recursive: true });

  for (const [name, body] of Object.entries(scripts)) {
    const path = join(dir, 'scripts', name);
    writeFileSync(path, body);
    chmodSync(path, 0o755);
  }

  return dir;
}

/** Put `dir`'s manifest where the broker reads it: the store, keyed by handle. */
function installManifest(handle: string, dir: string): void {
  ensureManifestDir();
  writeFileSync(manifestPathFor(handle), JSON.stringify(manifests.get(dir)));
}

/**
 * Register `dir` for `handle` AND install its manifest.
 *
 * Registration no longer decides where commands run. It stays because an agent
 * really is registered, so the tests run against the shape production has.
 */
function registerWith(handle: string, dir: string): void {
  registerProject(handle, dir);
  installManifest(handle, dir);
}

/**
 * Send lines and collect whatever comes back, then report whether the peer
 * closed.
 *
 * 🛑 RETURNS THE RAW BYTES, NOT PARSED OBJECTS. A refusal that writes NOTHING
 * and a refusal that writes an error envelope are the two outcomes under test,
 * and parsing first would make the empty case indistinguishable from a parse
 * failure.
 */
function exchange(port: number, lines: readonly string[], waitMs = 250): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    let received = '';
    let timer: NodeJS.Timeout;

    const finish = () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(received);
    };

    socket.on('error', reject);
    socket.on('data', (chunk) => {
      received += chunk.toString();
    });
    socket.on('close', finish);
    socket.once('connect', () => {
      for (const line of lines) socket.write(`${line}\n`);
      timer = setTimeout(finish, waitMs);
    });
  });
}

async function replies(port: number, envelopes: readonly unknown[], waitMs = 250) {
  const raw = await exchange(port, envelopes.map((e) => JSON.stringify(e)), waitMs);

  return raw
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const ECHO = {
  commands: [
    {
      name: 'gate',
      script: 'scripts/gate.sh',
      params: [{ name: 'lane', type: 'enum', values: ['php', 'js'] }],
    },
  ],
};

async function brokerFor(handle: string, dir: string, token = 'tok-secret'): Promise<Broker> {
  registerWith(handle, dir);

  return CommandBroker.bind({ authenticate: (t) => (t === token ? handle : null) });
}

/**
 * 🛑 A WRONG TOKEN LEARNS NOTHING. An error envelope would confirm the port is
 * a broker and that the request shape was right, which is a probe's whole goal.
 */
test('a wrong token is refused with no reply at all', async (t) => {
  const broker = await brokerFor(`h1-${process.pid}`, project(ECHO));
  t.after(() => broker.close());

  const raw = await exchange(broker.port, [
    JSON.stringify({ id: 1, token: 'wrong', op: 'list-commands' }),
  ]);

  assert.equal(raw, '', 'the broker answered an unauthenticated caller');
});

test('an unparseable line is refused with no reply at all', async (t) => {
  const broker = await brokerFor(`h2-${process.pid}`, project(ECHO));
  t.after(() => broker.close());

  assert.equal(await exchange(broker.port, ['{not json']), '');
});

test('list-commands returns the command names and their params', async (t) => {
  const broker = await brokerFor(`h3-${process.pid}`, project(ECHO));
  t.after(() => broker.close());

  const [reply] = await replies(broker.port, [
    { id: 7, token: 'tok-secret', op: 'list-commands' },
  ]);

  assert.equal(reply?.id, 7);
  assert.equal(reply?.ok, true);
  assert.deepEqual((reply?.commands as { name: string }[]).map((c) => c.name), ['gate']);
});

/**
 * 🛑 THE KEY IS ABSENT, NOT FALSY. `assert.equal(script, undefined)` passes for
 * a key that is present and null, and a null script is still a disclosure that
 * the field exists at all.
 */
test('list-commands never carries the script path', async (t) => {
  const broker = await brokerFor(`h4-${process.pid}`, project(ECHO));
  t.after(() => broker.close());

  const [reply] = await replies(broker.port, [
    { id: 1, token: 'tok-secret', op: 'list-commands' },
  ]);
  const listed = (reply?.commands as Record<string, unknown>[])[0]!;

  assert.equal(Object.hasOwn(listed, 'script'), false, 'the script path crossed the boundary');
  assert.equal(JSON.stringify(reply).includes('gate.sh'), false);
});

/**
 * 🛑 THE TOKEN DECIDES THE HANDLE, NEVER THE REQUEST. A request-supplied handle
 * would let one container name another and run inside that one's tree.
 *
 * The control is that `beta` is registered and HAS a reachable manifest, so a
 * broker that honoured the field would answer with `beta-only` rather than
 * fail. A missing beta would pass this test for the wrong reason.
 */
test('a handle named in the request is ignored', async (t) => {
  const alpha = `alpha-${process.pid}`;
  const beta = `beta-${process.pid}`;

  registerWith(beta, project({ commands: [{ name: 'beta-only', script: 'scripts/b.sh' }] }));

  const broker = await brokerFor(alpha, project(ECHO));
  t.after(() => broker.close());

  const [reply] = await replies(broker.port, [
    { id: 1, token: 'tok-secret', op: 'list-commands', handle: beta },
  ]);
  const names = (reply?.commands as { name: string }[]).map((c) => c.name);

  assert.deepEqual(names, ['gate'], 'the request-supplied handle was honoured');
});

test('run-command runs the script and reports its exit code and output', async (t) => {
  const dir = project(ECHO, { 'gate.sh': '#!/bin/sh\necho "lane=$1"\nexit 0\n' });
  const broker = await brokerFor(`h5-${process.pid}`, dir);
  t.after(() => broker.close());

  const [reply] = await replies(
    broker.port,
    [{ id: 3, token: 'tok-secret', op: 'run-command', name: 'gate', params: { lane: 'php' } }],
    1500,
  );

  assert.equal(reply?.ok, true, JSON.stringify(reply));
  assert.equal(reply?.exitCode, 0);
  assert.equal((reply?.stdout as string).trim(), 'lane=php');
});

/**
 * 🛑 THE SYMLINK CASE, AT THE BROKER RATHER THAN AT `checkedScriptPath`. The
 * unit test on containment proves the function refuses; this proves the broker
 * calls it. Deleting the call would leave the unit test green.
 */
test('run-command refuses a script that symlinks out of the project', async (t) => {
  const dir = project(ECHO);
  symlinkSync('/bin/sh', join(dir, 'scripts', 'gate.sh'));

  const broker = await brokerFor(`h6-${process.pid}`, dir);
  t.after(() => broker.close());

  const [reply] = await replies(
    broker.port,
    [{ id: 4, token: 'tok-secret', op: 'run-command', name: 'gate', params: { lane: 'php' } }],
    1500,
  );

  assert.equal(reply?.ok, false);
  assert.match(reply?.error as string, /not inside the project directory/);
});

test('an unknown command name is refused', async (t) => {
  const broker = await brokerFor(`h7-${process.pid}`, project(ECHO));
  t.after(() => broker.close());

  const [reply] = await replies(broker.port, [
    { id: 5, token: 'tok-secret', op: 'run-command', name: 'deploy', params: {} },
  ]);

  assert.equal(reply?.ok, false);
  assert.match(reply?.error as string, /no command "deploy"/);
});

test('an unknown op is refused by name', async (t) => {
  const broker = await brokerFor(`h8-${process.pid}`, project(ECHO));
  t.after(() => broker.close());

  const [reply] = await replies(broker.port, [
    { id: 6, token: 'tok-secret', op: 'rm-rf', name: 'gate' },
  ]);

  assert.equal(reply?.ok, false);
  assert.match(reply?.error as string, /unknown op/);
});

/**
 * 🛑 A COMMAND THAT NEVER EXITS MUST NOT HOLD THE BROKER. The second request is
 * the whole point — a broker that answers the timeout but is then wedged would
 * pass an assertion on the first reply alone.
 */
test('a hanging command times out and the broker still answers afterwards', async (t) => {
  const manifest = { commands: [{ name: 'hang', script: 'scripts/hang.sh' }] };
  const dir = project(manifest, { 'hang.sh': '#!/bin/sh\nsleep 30\n' });

  registerWith(`h9-${process.pid}`, dir);
  const broker = await CommandBroker.bind({
    authenticate: (tkn) => (tkn === 'tok-secret' ? `h9-${process.pid}` : null),
    timeoutMs: 300,
  });
  t.after(() => broker.close());

  const [timedOut] = await replies(
    broker.port,
    [{ id: 1, token: 'tok-secret', op: 'run-command', name: 'hang', params: {} }],
    2000,
  );

  assert.equal(timedOut?.ok, false);
  assert.match(timedOut?.error as string, /timed out/);

  const [after] = await replies(broker.port, [
    { id: 2, token: 'tok-secret', op: 'list-commands' },
  ]);

  assert.equal(after?.ok, true, 'the broker was wedged by the hanging command');
  assert.equal(after?.id, 2);
});

test('two envelopes on one connection each get their own answer', async (t) => {
  const broker = await brokerFor(`h10-${process.pid}`, project(ECHO));
  t.after(() => broker.close());

  const got = await replies(broker.port, [
    { id: 11, token: 'tok-secret', op: 'list-commands' },
    { id: 12, token: 'tok-secret', op: 'list-commands' },
  ]);

  assert.deepEqual(got.map((r) => r.id).sort(), [11, 12]);
});

/**
 * 🛑 THE `cancelled 1` FAILURE MODE. `server.close()` waits for every open
 * connection, and this listener keeps them open to read more than one line —
 * so without tracking them `close()` never settles and the runner reports a
 * CANCELLED test, which reads as green to anyone checking only `fail`.
 */
test('close() settles while a connection is still open', async () => {
  const broker = await brokerFor(`h11-${process.pid}`, project(ECHO));
  const socket = connect(broker.port, '127.0.0.1');

  await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
  await broker.close();

  socket.destroy();
  assert.ok(true);
});

/**
 * 🛑 THE ATTACK SLICE 3A EXISTS TO STOP. `projects.json` lives in the state
 * directory every container mounts READ-WRITE, so the agent can rewrite it.
 * Before this slice that moved the directory its own commands ran in.
 *
 * 🛑 THE REGISTRATION HOLDS ONLY THE DECOY, NEVER BOTH. `registerProject`
 * APPENDS, so registering real-then-decoy leaves real at index 0 and a
 * first-wins implementation still passes. That shape is a decoy test.
 */
test('rewriting the registration does not move where a command runs', async (t) => {
  const handle = `h12-${process.pid}`;
  const real = project(ECHO, { 'gate.sh': '#!/bin/sh\necho real\n' });
  const decoy = project(ECHO, { 'gate.sh': '#!/bin/sh\necho decoy\n' });

  installManifest(handle, real);
  registerProject(handle, decoy);

  // POSITIVE CONTROL. Without it a `registerProject` that silently no-opped
  // would leave this test green while proving nothing.
  assert.deepEqual(dirsFor(handle), [decoy]);

  const broker = await CommandBroker.bind({
    authenticate: (tkn) => (tkn === 'tok-secret' ? handle : null),
  });
  t.after(() => broker.close());

  const [reply] = await replies(broker.port, [
    { id: 1, token: 'tok-secret', op: 'run-command', name: 'gate', params: { lane: 'php' } },
  ]);

  assert.equal(reply?.ok, true, `the broker refused: ${String(reply?.error)}`);
  assert.match(reply?.stdout as string, /real/);
  assert.doesNotMatch(reply?.stdout as string, /decoy/);
});

/**
 * 🛑 NO MANIFEST IS A REFUSAL, NOT A DEFAULT. A broker that fell back to its own
 * cwd would run the operator's shell commands from wherever it happened to start.
 */
test('a handle with no manifest is refused, not defaulted to cwd', async (t) => {
  const broker = await CommandBroker.bind({
    authenticate: (tkn) => (tkn === 'tok-secret' ? `nowhere-${process.pid}` : null),
  });
  t.after(() => broker.close());

  const [reply] = await replies(broker.port, [
    { id: 1, token: 'tok-secret', op: 'list-commands' },
  ]);

  assert.equal(reply?.ok, false);
  assert.match(reply?.error as string, /no usable command manifest/);
});

/**
 * A registration is not needed at all now. This is the other half of the
 * rewrite test: the manifest alone is sufficient, so `projects.json` is not
 * consulted on either the present or the absent path.
 */
test('a handle with a manifest but no registration still runs its command', async (t) => {
  const handle = `h12b-${process.pid}`;
  const dir = project(ECHO, { 'gate.sh': '#!/bin/sh\necho unregistered\n' });

  installManifest(handle, dir);

  const broker = await CommandBroker.bind({
    authenticate: (tkn) => (tkn === 'tok-secret' ? handle : null),
  });
  t.after(() => broker.close());

  const [reply] = await replies(broker.port, [
    { id: 1, token: 'tok-secret', op: 'run-command', name: 'gate', params: { lane: 'php' } },
  ]);

  assert.equal(reply?.ok, true, `the broker refused: ${String(reply?.error)}`);
  assert.match(reply?.stdout as string, /unregistered/);
});

/**
 * 🛑 LOOPBACK ONLY. `dockerArgsForVendor` passes no `--network`, and §5 of the
 * handover measured a container reaching a host `127.0.0.1` bind through
 * `host.docker.internal` — so the bind address is not the boundary. The token
 * is. This asserts the bind anyway, because widening it to `0.0.0.0` would put
 * the broker on the operator's LAN.
 */
test('the broker binds loopback only', async (t) => {
  const broker = await brokerFor(`h13-${process.pid}`, project(ECHO));
  t.after(() => broker.close());

  assert.equal(broker.address, '127.0.0.1');
  assert.ok(broker.port > 0, 'port 0 was not read back');
});

/**
 * 🛑 A FAILING GATE IS AN ANSWER. Reporting a non-zero exit as a refusal would
 * make a gate that found a real bug indistinguishable from a rejected request.
 */
test('a non-zero exit is reported as an exit code, not as a refusal', async (t) => {
  const manifest = { commands: [{ name: 'fail', script: 'scripts/fail.sh' }] };
  const dir = project(manifest, { 'fail.sh': '#!/bin/sh\necho out\n>&2 echo err\nexit 3\n' });
  const broker = await brokerFor(`h14-${process.pid}`, dir);
  t.after(() => broker.close());

  const [reply] = await replies(
    broker.port,
    [{ id: 1, token: 'tok-secret', op: 'run-command', name: 'fail', params: {} }],
    1500,
  );

  assert.equal(reply?.ok, true, JSON.stringify(reply));
  assert.equal(reply?.exitCode, 3);
  assert.equal((reply?.stdout as string).trim(), 'out');
  assert.equal((reply?.stderr as string).trim(), 'err');
});


/**
 * 🛑 THE TRUST BOUNDARY, STATED AS A TEST SO IT CANNOT BE FORGOTTEN.
 *
 * The broker runs the script's CONTENT AS IT IS AT RUN TIME. A containerized
 * agent holds the project directory read-write, so that content is the agent's
 * to choose — no symlink and no race required.
 *
 * This is why `O_NOFOLLOW` would not close the hole: it pins the inode, and the
 * inode's bytes are already attacker-controlled. The real question is whether a
 * project script may be trusted at all, and that blocks slice 3.
 */
test('the broker runs the script content present at run time, not at check time', async (t) => {
  const manifest = { commands: [{ name: 'gate', script: 'scripts/gate.sh' }] };
  const dir = project(manifest, { 'gate.sh': '#!/bin/sh\necho first\n' });
  const broker = await brokerFor(`h16-${process.pid}`, dir);
  t.after(() => broker.close());

  writeFileSync(join(dir, 'scripts', 'gate.sh'), '#!/bin/sh\necho second\n');
  chmodSync(join(dir, 'scripts', 'gate.sh'), 0o755);

  const [reply] = await replies(
    broker.port,
    [{ id: 1, token: 'tok-secret', op: 'run-command', name: 'gate', params: {} }],
    1500,
  );

  assert.equal((reply?.stdout as string).trim(), 'second');
});

/** Like `exchange`, but says whether the BROKER closed the connection. */
function probe(port: number, payload: Buffer | readonly Buffer[], waitMs = 400) {
  return new Promise<{ raw: string; closed: boolean }>((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    let raw = '';
    let closed = false;
    let timer: NodeJS.Timeout;

    socket.on('error', reject);
    socket.on('data', (c) => {
      raw += c.toString();
    });
    socket.on('close', () => {
      closed = true;
      clearTimeout(timer);
      resolve({ raw, closed });
    });
    socket.once('connect', () => {
      for (const part of Array.isArray(payload) ? payload : [payload]) socket.write(part);
      timer = setTimeout(() => {
        socket.destroy();
        resolve({ raw, closed });
      }, waitMs);
    });
  });
}

/**
 * 🛑 THE ASSERTION IS THAT THE BROKER CLOSED, NOT THAT IT STAYED SILENT.
 *
 * The first version of this test sent the oversized payload WITH a newline, so
 * it reached `JSON.parse`, threw, and the socket was destroyed — identical
 * bytes on the wire with the cap deleted. Proven vacuous by deleting the cap
 * and watching 18/18 still pass. Without a newline there is nothing to parse,
 * so only the cap can end the connection.
 */
test('a line longer than the cap closes the connection', async (t) => {
  const broker = await brokerFor(`h17-${process.pid}`, project(ECHO));
  t.after(() => broker.close());

  const { raw, closed } = await probe(broker.port, Buffer.from('x'.repeat(70 * 1024)));

  assert.equal(raw, '');
  assert.equal(closed, true, 'the oversized line was buffered instead of refused');
});

/**
 * 🛑 A MULTI-BYTE CHARACTER SPLIT ACROSS TCP SEGMENTS. `chunk.toString()` per
 * chunk turns the halves into U+FFFD and loses the rest; a `StringDecoder`
 * holds the partial sequence until the next chunk completes it.
 */
test('an envelope split mid-character is reassembled intact', async (t) => {
  const broker = await brokerFor(`h18-${process.pid}`, project(ECHO));
  t.after(() => broker.close());

  const line = Buffer.from(
    `${JSON.stringify({ id: 1, token: 'tok-secret', op: 'run-command', name: 'gate-✅', params: {} })}\n`,
    'utf8',
  );
  const cut = line.indexOf(Buffer.from('✅', 'utf8')) + 1;
  const { raw } = await probe(broker.port, [line.subarray(0, cut), line.subarray(cut)]);
  const reply = JSON.parse(raw.split('\n')[0] as string) as Record<string, unknown>;

  assert.equal(reply.ok, false);
  assert.match(reply.error as string, /no command "gate-✅"/);
});

/**
 * 🛑 "NOT NULL" IS NOT "AUTHENTICATED". `undefined` is what a `Map.get` miss or
 * a missing `return` hands back, and a `handle === null` gate lets it through.
 */
test('an authenticate that returns undefined does not authenticate', async (t) => {
  registerWith(`h19-${process.pid}`, project(ECHO));
  const broker = await CommandBroker.bind({
    authenticate: () => undefined as unknown as string | null,
  });
  t.after(() => broker.close());

  const { raw } = await probe(
    broker.port,
    Buffer.from(`${JSON.stringify({ id: 1, token: 'anything', op: 'list-commands' })}\n`),
  );

  assert.equal(raw, '');
});

test('an authenticate that returns an empty string does not authenticate', async (t) => {
  const broker = await CommandBroker.bind({ authenticate: () => '' });
  t.after(() => broker.close());

  const { raw } = await probe(
    broker.port,
    Buffer.from(`${JSON.stringify({ id: 1, token: 'anything', op: 'list-commands' })}\n`),
  );

  assert.equal(raw, '');
});

/**
 * 🛑 A THROW FROM `authenticate` MUST NOT TAKE THE SUPERVISOR DOWN. It is
 * supplied by the caller of `bind` and reached with a caller-controlled token,
 * so an unhandled rejection here would be a remote kill switch.
 */
test('a throwing authenticate refuses the caller and leaves the broker alive', async (t) => {
  const handle = `h20-${process.pid}`;
  registerWith(handle, project(ECHO));

  let explode = true;
  const broker = await CommandBroker.bind({
    authenticate: (tkn) => {
      if (explode) throw new Error('config blew up');

      return tkn === 'tok-secret' ? handle : null;
    },
  });
  t.after(() => broker.close());

  const first = await probe(
    broker.port,
    Buffer.from(`${JSON.stringify({ id: 1, token: 'tok-secret', op: 'list-commands' })}\n`),
  );

  assert.equal(first.raw, '');

  explode = false;
  const [after] = await replies(broker.port, [
    { id: 2, token: 'tok-secret', op: 'list-commands' },
  ]);

  assert.equal(after?.ok, true, 'the broker died with the throwing authenticate');
});

/**
 * 🛑 ONE WRITE CAN CARRY MANY ENVELOPES, AND EACH ONE SPAWNS A HOST PROCESS.
 * Without the cap, a single chunk of N run-commands starts N processes at once,
 * each with the full timeout and output budget.
 */
test('more requests than the in-flight cap are refused rather than all run', async (t) => {
  const manifest = { commands: [{ name: 'slow', script: 'scripts/slow.sh' }] };
  const dir = project(manifest, { 'slow.sh': '#!/bin/sh\nsleep 1\necho done\n' });
  const handle = `h21-${process.pid}`;

  registerWith(handle, dir);
  const broker = await CommandBroker.bind({
    authenticate: (tkn) => (tkn === 'tok-secret' ? handle : null),
    maxInFlight: 1,
  });
  t.after(() => broker.close());

  const got = await replies(
    broker.port,
    [
      { id: 1, token: 'tok-secret', op: 'run-command', name: 'slow', params: {} },
      { id: 2, token: 'tok-secret', op: 'run-command', name: 'slow', params: {} },
    ],
    2500,
  );
  const busy = got.filter((r) => r.error === 'the broker is busy; retry');

  assert.equal(busy.length, 1, JSON.stringify(got));
});

/**
 * 🛑 NO HOST PATH CROSSES THE BOUNDARY. The caller writes the manifest, so a
 * refusal that names what a path resolved to is an arbitrary-path existence and
 * realpath oracle for the whole host.
 */
test('a refusal never carries a host path — the containment refusal', async (t) => {
  const dir = project(ECHO);
  symlinkSync('/bin/sh', join(dir, 'scripts', 'gate.sh'));

  const broker = await brokerFor(`h22-${process.pid}`, dir);
  t.after(() => broker.close());

  const [reply] = await replies(
    broker.port,
    [{ id: 1, token: 'tok-secret', op: 'run-command', name: 'gate', params: { lane: 'php' } }],
    1500,
  );

  assert.equal(reply?.ok, false);
  assert.equal(
    (reply?.error as string).includes('/'),
    false,
    `the refusal leaked a path: ${String(reply?.error)}`,
  );
});

/**
 * ⚠️ THE SIBLING ABOVE REACHES `checkedScriptPath` AND STOPS THERE. This one
 * reaches `runScript`, where `execFile` puts the absolute path into
 * `err.message` — a different mechanism for the same property, so neither test
 * covers the other.
 */
test('a refusal never carries a host path — a spawn failure', async (t) => {
  const dir = project(ECHO, { 'gate.sh': '#!/bin/sh\necho hi\n' });

  chmodSync(join(dir, 'scripts', 'gate.sh'), 0o644);

  const broker = await brokerFor(`h23-${process.pid}`, dir);
  t.after(() => broker.close());

  const [reply] = await replies(
    broker.port,
    [{ id: 1, token: 'tok-secret', op: 'run-command', name: 'gate', params: { lane: 'php' } }],
    1500,
  );

  assert.equal(reply?.ok, false);
  assert.equal(
    (reply?.error as string).includes('/'),
    false,
    `the refusal leaked a path: ${String(reply?.error)}`,
  );
});

