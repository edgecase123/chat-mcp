import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), 'chat-mcp-equivalence-'));

const { setToken } = await import('../../../src/supervise/auth.js');
const { dockerArgsFor } = await import('../../../src/supervise/drivers/docker-claude.js');
const { claudeArgs } = await import('../../../src/supervise/drivers/claude.js');
const { claudeSpawn } = await import('../../../src/adapters/claude-spawn.js');

const PROJECT_DIR = join(process.env.CHAT_MCP_HOME, 'project');
mkdirSync(PROJECT_DIR, { recursive: true });

test('the adapter host argv equals the host driver argv today', () => {
  const opts = { cwd: PROJECT_DIR, model: 'opus', supervisorHandle: 'claude1' };

  assert.deepEqual(claudeSpawn.argsFor(opts, 'host'), claudeArgs(opts));
});

test('🛑 the adapter docker argv equals the CLI tail of dockerArgsFor today', () => {
  setToken('sk-ant-oat-x');
  const opts = { cwd: PROJECT_DIR, model: 'opus', supervisorHandle: 'claude1' };

  const full = dockerArgsFor(opts);
  // Everything after the image tag is the CLI invocation; everything before it
  // is docker's own argv. Splitting on the binary name is what makes this
  // comparison about the CLI flags and not about the mounts.
  const cliTail = full.slice(full.indexOf('claude') + 1);

  assert.deepEqual(claudeSpawn.argsFor(opts, 'docker'), cliTail);
});

const { dockerArgsForVendor } = await import('../../../src/supervise/drivers/containerized.js');

test('🛑 the generic container argv is byte-identical to dockerArgsFor today', () => {
  setToken('sk-ant-oat-x');
  const opts = { cwd: PROJECT_DIR, model: 'opus', supervisorHandle: 'claude1' };

  assert.deepEqual(dockerArgsForVendor(claudeSpawn, opts), dockerArgsFor(opts));
});
