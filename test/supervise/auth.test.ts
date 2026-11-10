import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), 'chat-mcp-auth-'));

const { setToken, readToken, secretsEnvPath } = await import('../../src/supervise/auth.js');

test('no token on file reads as null, not a throw', () => {
  assert.equal(readToken(), null);
});

test('a stored token round-trips', () => {
  setToken('sk-ant-oat-example');
  assert.equal(readToken(), 'sk-ant-oat-example');
});

test('the file is owner-only (0600)', () => {
  setToken('sk-ant-oat-example');
  assert.equal(statSync(secretsEnvPath()).mode & 0o777, 0o600);
});

test('leading/trailing whitespace on the token is trimmed before storing', () => {
  setToken('  sk-ant-oat-ws  \n');
  assert.equal(readToken(), 'sk-ant-oat-ws');
});

test('an empty token is refused rather than stored', () => {
  assert.throws(() => setToken('   '), /empty/);
});

test('setting a new token replaces the old one, not appends', () => {
  setToken('sk-ant-oat-first');
  setToken('sk-ant-oat-second');
  assert.equal(readToken(), 'sk-ant-oat-second');
});
