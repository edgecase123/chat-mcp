import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
