import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 🛑 BEFORE any import that resolves a state path.
process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), 'chat-mcp-tools-'));

const { CommandBroker } = await import('../../src/supervise/broker.js');
const { registerProject } = await import('../../src/supervise/projects.js');
const { ensureManifestDir, manifestPathFor } = await import('../../src/util/paths.js');
const { CLOSED_SILENTLY, NO_BROKER, REFUSED } = await import('../../src/shim/broker-client.js');
const { askForTool, installRunCommand } = await import('../../src/shim/tools/run_command.js');

type Broker = Awaited<ReturnType<typeof CommandBroker.bind>>;

const TOKEN = 'tok-secret';

const MANIFEST = {
  commands: [
    {
      name: 'gate',
      script: 'scripts/gate.sh',
      params: [{ name: 'lane', type: 'enum', values: ['php', 'js'] }],
    },
    { name: 'boom', script: 'scripts/boom.sh', params: [] },
  ],
};

/** A project directory with two runnable scripts, plus its manifest in the store. */
function brokerFor(handle: string): Promise<Broker> {
  const dir = mkdtempSync(join(tmpdir(), 'chat-mcp-tools-project-'));

  mkdirSync(join(dir, 'scripts'), { recursive: true });

  const gate = join(dir, 'scripts', 'gate.sh');
  writeFileSync(gate, '#!/bin/sh\necho "lane=$1"\n');
  chmodSync(gate, 0o755);

  // Exists so a NON-ZERO EXIT has its own command. A failing command is a
  // RESULT, and the test below separates it from a refusal.
  const boom = join(dir, 'scripts', 'boom.sh');
  writeFileSync(boom, '#!/bin/sh\necho out\necho err >&2\nexit 3\n');
  chmodSync(boom, 0o755);

  registerProject(handle, dir);
  ensureManifestDir();
  writeFileSync(manifestPathFor(handle), JSON.stringify({ projectDir: dir, ...MANIFEST }));

  return CommandBroker.bind({ authenticate: (t) => (t === TOKEN ? handle : null) });
}

const handleFor = (name: string) => `${name}-${process.pid}`;

const envFor = (port: number, token = TOKEN) => ({
  CHAT_MCP_BROKER_PORT: String(port),
  CHAT_MCP_BROKER_TOKEN: token,
});

// ---------------------------------------------------------------------------
// The CONTROL comes first. Without it every refusal test below would pass on a
// client that failed on everything.
// ---------------------------------------------------------------------------

test('CONTROL — a valid token lists the manifest commands and runs one', async () => {
  const handle = handleFor('control');
  const broker = await brokerFor(handle);

  try {
    const listed = await askForTool('list-commands', {}, envFor(broker.port));

    assert.equal(listed.ok, true);
    assert.deepEqual(
      (listed.commands as { name: string }[]).map((c) => c.name),
      ['gate', 'boom'],
    );

    const ran = await askForTool(
      'run-command',
      { name: 'gate', params: { lane: 'php' } },
      envFor(broker.port),
    );

    assert.equal(ran.ok, true);
    assert.equal(ran.exitCode, 0);
    assert.equal(ran.stdout, 'lane=php\n');
  } finally {
    await broker.close();
  }
});

// ---------------------------------------------------------------------------
// §3's four causes, each by its own cause
// ---------------------------------------------------------------------------

test('🛑 ABSENT VARS ARE THE NORMAL CASE — it refuses and never opens a socket', async () => {
  const reply = await askForTool('list-commands', {}, {});

  assert.equal(reply.ok, false);
  assert.equal(reply.error, NO_BROKER);
});

test('nothing listening on the port reads as a refused connection', async () => {
  const handle = handleFor('refused');
  const broker = await brokerFor(handle);
  const port = broker.port;

  // Freed deliberately, so the port is one nothing answers on.
  await broker.close();

  const reply = await askForTool('list-commands', {}, envFor(port));

  assert.equal(reply.ok, false);
  assert.equal(reply.error, REFUSED);
});

test("🛑 A WRONG TOKEN IS DESTROYED SILENTLY, so it must settle as a CLOSE and name that cause", async () => {
  const handle = handleFor('wrongtoken');
  const broker = await brokerFor(handle);

  try {
    const reply = await askForTool('list-commands', {}, envFor(broker.port, 'not-the-token'));

    assert.equal(reply.ok, false);
    // Asserting the SENTENCE, not a timeout value. A bare timeout assertion
    // passes on a client that never connected at all.
    assert.equal(reply.error, CLOSED_SILENTLY);
  } finally {
    await broker.close();
  }
});

test("a broker refusal carries the broker's own sentence, verbatim", async () => {
  const handle = handleFor('refusal');
  const broker = await brokerFor(handle);

  try {
    const reply = await askForTool(
      'run-command',
      { name: 'no-such-command', params: {} },
      envFor(broker.port),
    );

    assert.equal(reply.ok, false);
    assert.equal(typeof reply.error, 'string');
    // The broker never sends a host path, so a refusal must not carry one.
    assert.doesNotMatch(reply.error as string, /\/(private\/)?(var|tmp)\//);
  } finally {
    await broker.close();
  }
});

// ---------------------------------------------------------------------------
// The distinction a single `ok` flag is most likely to lose
// ---------------------------------------------------------------------------

test('🛑 A NON-ZERO EXIT IS A RESULT, NOT A REFUSAL — ok stays true', async () => {
  const handle = handleFor('nonzero');
  const broker = await brokerFor(handle);

  try {
    const reply = await askForTool('run-command', { name: 'boom', params: {} }, envFor(broker.port));

    assert.equal(reply.ok, true, 'a command that exited 3 must not read as a refusal');
    assert.equal(reply.exitCode, 3);
    assert.equal(reply.stdout, 'out\n');
    assert.equal(reply.stderr, 'err\n');
  } finally {
    await broker.close();
  }
});

// ---------------------------------------------------------------------------
// Registration — an ordinary session must not advertise a capability it lacks
// ---------------------------------------------------------------------------

function recordingServer(): { names: string[]; server: Parameters<typeof installRunCommand>[0] } {
  const names: string[] = [];
  const server = { registerTool: (name: string) => void names.push(name) };

  return { names, server: server as unknown as Parameters<typeof installRunCommand>[0] };
}

test('🛑 WITH NO BROKER, NEITHER TOOL IS REGISTERED AT ALL', () => {
  const { names, server } = recordingServer();

  installRunCommand(server, {});

  assert.deepEqual(names, []);
});

test('with a broker, both tools are registered', () => {
  const { names, server } = recordingServer();

  installRunCommand(server, envFor(4000));

  assert.deepEqual(names, ['list_commands', 'run_command']);
});
