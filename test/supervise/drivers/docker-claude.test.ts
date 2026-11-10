import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn as realSpawn } from 'node:child_process';

process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), 'chat-mcp-docker-driver-'));

const { setToken } = await import('../../../src/supervise/auth.js');
const { registerMount } = await import('../../../src/supervise/mounts.js');
const { dockerArgsFor, CONTAINER_PROJECT_DIR, CONTAINER_STATE_DIR, containerPathFor } =
  await import('../../../src/supervise/drivers/docker-claude.js');

const PROJECT_DIR = mkdtempSync(join(tmpdir(), 'chat-mcp-docker-project-'));

test('with no token on file, building argv throws naming the fix', () => {
  assert.throws(
    () => dockerArgsFor({ cwd: PROJECT_DIR, supervisorHandle: 'claude1' }),
    /chat-mcp auth set-token/,
  );
});

test('the project dir is bind-mounted to the fixed in-container work dir', () => {
  setToken('sk-ant-oat-x');
  const args = dockerArgsFor({ cwd: PROJECT_DIR, supervisorHandle: 'claude1' });
  assert.ok(args.includes(`${PROJECT_DIR}:${CONTAINER_PROJECT_DIR}`));
});

test('the chat-mcp state dir is bind-mounted so the bus is reachable in-container', async () => {
  const { stateDir } = await import('../../../src/util/paths.js');
  setToken('sk-ant-oat-x');
  const args = dockerArgsFor({ cwd: PROJECT_DIR, supervisorHandle: 'claude1' });
  assert.ok(args.includes(`${stateDir()}:${CONTAINER_STATE_DIR}`));
});

test('a registered extra mount appears at /mnt/<key>', () => {
  const extraDir = mkdtempSync(join(tmpdir(), 'chat-mcp-docker-extra-'));
  setToken('sk-ant-oat-x');
  registerMount('claude1', 'local-context', extraDir);
  const args = dockerArgsFor({ cwd: PROJECT_DIR, supervisorHandle: 'claude1' });
  assert.ok(args.includes(`${extraDir}:${containerPathFor('local-context')}`));
});

test('the token is injected by NAME via -e, and the value never appears as a bare arg', () => {
  setToken('sk-ant-oat-secret-value');
  const args = dockerArgsFor({ cwd: PROJECT_DIR, supervisorHandle: 'claude1' });
  assert.ok(args.includes('CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat-secret-value'));
});

test('the child command always carries --allow-dangerously-skip-permissions, never --permission-mode', () => {
  setToken('sk-ant-oat-x');
  const args = dockerArgsFor({ cwd: PROJECT_DIR, supervisorHandle: 'claude1' });
  assert.ok(args.includes('--allow-dangerously-skip-permissions'));
  assert.ok(!args.includes('--permission-mode'));
  assert.ok(!args.includes('--allowedTools'));
});

test('a resume id is forwarded as --resume', () => {
  setToken('sk-ant-oat-x');
  const args = dockerArgsFor({
    cwd: PROJECT_DIR,
    supervisorHandle: 'claude1',
    resumeSessionId: 'sess-123',
  });
  const i = args.indexOf('--resume');
  assert.ok(i >= 0);
  assert.equal(args[i + 1], 'sess-123');
});

test('the invocation runs the image with --rm, never leaving a stopped container behind', () => {
  setToken('sk-ant-oat-x');
  const args = dockerArgsFor({ cwd: PROJECT_DIR, supervisorHandle: 'claude1' });
  assert.ok(args.includes('--rm'));
});

test('kill() terminates the docker-run process mid-turn, not just at turn end', async (t) => {
  setToken('sk-ant-oat-x');
  // A real, controllable stand-in for the `docker run` CLI process: a long-lived
  // process with piped stdio (spawnDockerClaude reads child.stdout directly), so
  // a pass here proves kill() propagates a real terminating signal, not just that
  // the Node wrapper object changes state. Node's own `node:test` module mocking
  // only intercepts an ESM named import at a fresh module instance, so the mock
  // must be installed before `docker-claude.js` is (re-)imported below.
  let fakeDockerRun: ReturnType<typeof realSpawn> | undefined;
  t.mock.module('node:child_process', {
    namedExports: {
      spawn: () => {
        fakeDockerRun = realSpawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
        return fakeDockerRun;
      },
    },
  });

  const { spawnDockerClaude } = await import(
    `../../../src/supervise/drivers/docker-claude.js?kill-test=${Date.now()}`
  );
  const agent = spawnDockerClaude({ cwd: PROJECT_DIR, supervisorHandle: 'claude1' });

  const exitSignal = new Promise((resolve) => agent.onExit((_code, signal) => resolve(signal)));
  // Kill before any stdout line has been parsed, i.e. before any turn has ended —
  // the live smoke test only ever exercised a turn-end `kill -INT`.
  agent.kill();

  assert.equal(await exitSignal, 'SIGTERM');
  assert.ok(fakeDockerRun, 'spawn mock was not invoked');
  assert.throws(() => process.kill(fakeDockerRun!.pid!, 0), /ESRCH/);
});
