import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 🛑 BEFORE any import that resolves a state path.
process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), 'chat-mcp-rcs-'));

const { Refusal, listCommandsFor, runCommandFor } = await import(
  '../../src/supervise/run-command-service.js'
);
const { registerProject } = await import('../../src/supervise/projects.js');
const { ensureManifestDir, manifestPathFor } = await import('../../src/util/paths.js');

/** A project directory with the scripts its manifest names. */
function project(
  commands: unknown,
  scripts: Readonly<Record<string, string>> = {},
): { dir: string; manifest: unknown } {
  const dir = mkdtempSync(join(tmpdir(), 'chat-mcp-project-'));

  mkdirSync(join(dir, 'scripts'), { recursive: true });

  for (const [name, body] of Object.entries(scripts)) {
    const path = join(dir, 'scripts', name);
    writeFileSync(path, body);
    chmodSync(path, 0o755);
  }

  return { dir, manifest: { projectDir: dir, ...(commands as object) } };
}

function install(handle: string, built: { dir: string; manifest: unknown }): string {
  installManifestOnly(handle, built);
  registerProject(handle, built.dir);

  return built.dir;
}

/** The manifest alone, so a test can point the REGISTRATION somewhere else. */
function installManifestOnly(handle: string, built: { dir: string; manifest: unknown }): void {
  ensureManifestDir();
  writeFileSync(manifestPathFor(handle), JSON.stringify(built.manifest));
}

const GATE = {
  commands: [{ name: 'run-gate', script: 'scripts/gate.sh' }],
};

test('the service is reachable without a transport, and lists a handle\'s commands', () => {
  install('lister', project(GATE, { 'gate.sh': '#!/bin/sh\necho hi\n' }));

  const { commands } = listCommandsFor('lister');

  assert.deepEqual(
    commands.map((c) => c.name),
    ['run-gate'],
  );
});

test('a listed command never carries its script path to the caller', () => {
  install('nopath', project(GATE, { 'gate.sh': '#!/bin/sh\necho hi\n' }));

  const { commands } = listCommandsFor('nopath');

  assert.equal(JSON.stringify(commands).includes('gate.sh'), false);
});

test('a command runs in the directory the MANIFEST names', async () => {
  const dir = install('runner', project(GATE, { 'gate.sh': '#!/bin/sh\npwd\n' }));

  const result = await runCommandFor('runner', 'run-gate', {});

  assert.equal(result.exitCode, 0);
  // macOS /var is a symlink to /private/var, so compare the tail.
  assert.equal(result.stdout.trim().endsWith(dir.replace(/^\/private/, '')), true);
});

test('a NON-ZERO exit is a RESULT, not a refusal', async () => {
  install('failer', project(GATE, { 'gate.sh': '#!/bin/sh\necho out\nexit 3\n' }));

  const result = await runCommandFor('failer', 'run-gate', {});

  assert.equal(result.exitCode, 3);
  assert.equal(result.stdout.trim(), 'out');
});

test('a handle with no manifest is REFUSED, and the caller is told nothing about the host', async () => {
  await assert.rejects(
    () => runCommandFor('nomanifest', 'run-gate', {}),
    (err: unknown) => {
      assert.ok(err instanceof Refusal, 'must be a Refusal');
      assert.equal(err.message, 'this agent has no usable command manifest');

      return true;
    },
  );
});

test('a Refusal keeps the operator detail OFF the public message', async () => {
  await assert.rejects(
    () => runCommandFor('nomanifest2', 'run-gate', {}),
    (err: unknown) => {
      assert.ok(err instanceof Refusal);
      // The detail exists for the host log and is NOT the public sentence.
      assert.notEqual(err.detail, err.message);

      return true;
    },
  );
});

test('a command name absent from the manifest is refused however it is spelled', async () => {
  install('narrow', project(GATE, { 'gate.sh': '#!/bin/sh\necho hi\n' }));

  await assert.rejects(
    () => runCommandFor('narrow', 'run-deploy', {}),
    (err: unknown) => err instanceof Refusal,
  );
});

test('a script outside the project directory is refused', async () => {
  const built = project(
    { commands: [{ name: 'escape', script: '../../etc/hosts' }] },
    { 'gate.sh': '#!/bin/sh\necho hi\n' },
  );
  install('escapee', built);

  await assert.rejects(
    () => runCommandFor('escapee', 'escape', {}),
    (err: unknown) => {
      assert.ok(err instanceof Refusal);
      assert.equal(err.message.includes('/etc/hosts'), false, 'no host path to the caller');

      return true;
    },
  );
});

/**
 * 🛑 THE SIBLING OF `broker.test.ts`'s REGISTRATION TEST, AT THIS LAYER.
 *
 * That one drives the socket. This service is reachable with no socket at all,
 * so the immunity needs pinning where the call now enters.
 *
 * 🛑 THE REGISTRATION HOLDS ONLY THE DECOY, NEVER BOTH. `registerProject`
 * APPENDS, so registering real-then-decoy leaves real at index 0 and any
 * implementation reading index 0 still passes. That shape is a decoy test.
 */
test('rewriting the registration does not move where a command runs', async () => {
  const real = project(GATE, { 'gate.sh': '#!/bin/sh\necho real\n' });
  const decoy = project(GATE, { 'gate.sh': '#!/bin/sh\necho decoy\n' });

  installManifestOnly('swapped', real);
  registerProject('swapped', decoy.dir);

  const result = await runCommandFor('swapped', 'run-gate', {});

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /real/);
  assert.doesNotMatch(result.stdout, /decoy/);
});
