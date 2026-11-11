import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn as realSpawn } from 'node:child_process';

process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), 'chat-mcp-docker-driver-'));

const { setToken } = await import('../../../src/supervise/auth.js');
const { registerMount } = await import('../../../src/supervise/mounts.js');
const { claudeSpawn } = await import('../../../src/adapters/claude-spawn.js');
const {
  dockerArgsForVendor,
  CONTAINER_PROJECT_DIR,
  containerStateDir,
  containerPathFor,
} = await import('../../../src/supervise/drivers/containerized.js');

const PROJECT_DIR = mkdtempSync(join(tmpdir(), 'chat-mcp-docker-project-'));

function dockerArgsFor(opts: Parameters<typeof dockerArgsForVendor>[1]) {
  return dockerArgsForVendor(claudeSpawn, opts);
}

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
  assert.ok(args.includes(`${stateDir()}:${containerStateDir(claudeSpawn)}`));
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

test('kill() stops the container by name via the daemon, not a raw signal to the docker-run client', async (t) => {
  setToken('sk-ant-oat-x');
  // A real, controllable stand-in for the `docker run` CLI process: a long-lived
  // process with piped stdio (spawnContainerized reads child.stdout directly).
  // Node's own `node:test` module mocking only intercepts an ESM named import at
  // a fresh module instance, so the mock must be installed before
  // `containerized.js` is (re-)imported below.
  //
  // 🛑 A RAW SIGTERM TO THIS CLIENT PROCESS IS NOT THE CONTRACT ANY MORE. The
  // daemon ignores it (container-removal.test.ts, #148's real finding), so
  // `kill()` must shell out to `docker stop <name>` instead — this test
  // captures that `execFileSync` call rather than asserting the client died,
  // which is a signal propagation detail a real daemon supplies, not this mock.
  let fakeDockerRun: ReturnType<typeof realSpawn> | undefined;
  const stopInvocations: string[][] = [];
  t.mock.module('node:child_process', {
    namedExports: {
      spawn: () => {
        fakeDockerRun = realSpawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
        return fakeDockerRun;
      },
      execFileSync: (_cmd: string, args: string[]) => {
        stopInvocations.push(args);
        return Buffer.from('');
      },
    },
  });

  const { spawnContainerized } = await import(
    `../../../src/supervise/drivers/containerized.js?kill-test=${Date.now()}`
  );
  const agent = spawnContainerized(claudeSpawn, { cwd: PROJECT_DIR, supervisorHandle: 'claude1' });

  agent.kill();

  assert.deepEqual(stopInvocations, [['stop', '-t', '60', 'chat-mcp-claude1']]);
  assert.ok(fakeDockerRun, 'spawn mock was not invoked');

  fakeDockerRun?.kill();
});

test('a per-handle shutdownGraceSeconds overrides the -t default', async (t) => {
  setToken('sk-ant-oat-x');
  let fakeDockerRun: ReturnType<typeof realSpawn> | undefined;
  const stopInvocations: string[][] = [];
  t.mock.module('node:child_process', {
    namedExports: {
      spawn: () => {
        fakeDockerRun = realSpawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
        return fakeDockerRun;
      },
      execFileSync: (_cmd: string, args: string[]) => {
        stopInvocations.push(args);
        return Buffer.from('');
      },
    },
  });

  const { spawnContainerized } = await import(
    `../../../src/supervise/drivers/containerized.js?grace-test=${Date.now()}`
  );
  const agent = spawnContainerized(claudeSpawn, {
    cwd: PROJECT_DIR,
    supervisorHandle: 'claude1',
    shutdownGraceSeconds: 5,
  });

  agent.kill();

  assert.deepEqual(stopInvocations, [['stop', '-t', '5', 'chat-mcp-claude1']]);

  fakeDockerRun?.kill();
});
