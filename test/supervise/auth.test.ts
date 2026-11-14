import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), 'chat-mcp-auth-'));

const {
  setToken,
  readToken,
  setGhToken,
  readGhToken,
  clearGhToken,
  hasGhToken,
  secretsEnvPath,
} = await import('../../src/supervise/auth.js');

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

/**
 * #214's GitHub half. lee ruled on 2026-11-13: ONE shared `GH_TOKEN`, in one
 * shared file, not one per handle. These mirror the Claude-token tests above
 * because the storage is deliberately the same shape.
 */

test('no gh token on file reads as null, not a throw', () => {
  assert.equal(readGhToken(), null);
});

test('a stored gh token round-trips', () => {
  setGhToken('ghp-example');
  assert.equal(readGhToken(), 'ghp-example');
});

test('storing a gh token leaves the file owner-only (0600)', () => {
  setGhToken('ghp-example');
  assert.equal(statSync(secretsEnvPath()).mode & 0o777, 0o600);
});

test('leading/trailing whitespace on the gh token is trimmed before storing', () => {
  setGhToken('  ghp-ws  \n');
  assert.equal(readGhToken(), 'ghp-ws');
});

test('an empty gh token is refused rather than stored', () => {
  assert.throws(() => setGhToken('   '), /empty/);
});

test('setting a new gh token replaces the old one, not appends', () => {
  setGhToken('ghp-first');
  setGhToken('ghp-second');
  assert.equal(readGhToken(), 'ghp-second');
});

/**
 * 🛑 THE HAZARD OF ONE SHARED FILE, AND THE REASON `setToken` CANNOT JUST
 * OVERWRITE IT. Both tokens live in `secrets.env` because lee chose shared
 * storage. A writer that rewrites the whole file silently drops the other
 * credential, and the only symptom is an agent that cannot reach GitHub —
 * or cannot reach Claude — some arbitrary time later.
 *
 * Both directions, because one writer fixed and the other not is the same
 * bug with half the blast radius.
 */
test('setting the gh token does not wipe the Claude token', () => {
  setToken('sk-ant-oat-keepme');
  setGhToken('ghp-added-after');

  assert.equal(readToken(), 'sk-ant-oat-keepme');
  assert.equal(readGhToken(), 'ghp-added-after');
});

test('setting the Claude token does not wipe the gh token', () => {
  setGhToken('ghp-keepme');
  setToken('sk-ant-oat-added-after');

  assert.equal(readGhToken(), 'ghp-keepme');
  assert.equal(readToken(), 'sk-ant-oat-added-after');
});

/**
 * The guard that keeps one line per credential true. Without it the tail of a
 * pasted multi-line token lands on its own line, where it either parses as
 * another key or vanishes — and the next read returns a TRUNCATED credential
 * rather than failing. Both tokens go through the same writer, so one test
 * covers both.
 */
test('a token containing a newline is refused rather than splitting the file', () => {
  assert.throws(() => setGhToken('ghp-head\nghp-tail'), /newline/);
  assert.throws(() => setToken('sk-ant-oat-head\nsk-ant-oat-tail'), /newline/);
});

/**
 * The paired control for the writer's trim. A token pasted with a trailing
 * newline is the NORMAL case — `pbpaste` and a heredoc both add one — so the
 * guard above must not reject it.
 */
test('a single trailing newline is trimmed, not treated as an embedded one', () => {
  setGhToken('ghp-trailing\n');
  assert.equal(readGhToken(), 'ghp-trailing');
});

test('hasGhToken answers presence without the caller ever holding the value', () => {
  clearGhToken();
  assert.equal(hasGhToken(), false);

  setGhToken('ghp-present');
  assert.equal(hasGhToken(), true);
});

/**
 * The write is atomic, so the temp file must not survive it. A lingering
 * `secrets.env.tmp` would be a second copy of both credentials at `0600`,
 * which is a credential sitting somewhere nobody looks.
 */
test('the atomic write leaves no temp file behind', () => {
  setGhToken('ghp-atomic');

  assert.equal(existsSync(`${secretsEnvPath()}.tmp`), false);
  assert.equal(readGhToken(), 'ghp-atomic');
});

/**
 * 🛑 THE DROP IS ANNOUNCED, AND THE ANNOUNCEMENT HOLDS NO SECRET. The next
 * write rebuilds the file from what parsed, so an unparseable line is gone for
 * good — and a credential that vanished with no error at the moment of loss is
 * the failure this module is shaped to avoid.
 */
test('an unparseable line is reported by LINE NUMBER, never by content', () => {
  setGhToken('ghp-keep');

  writeFileSync(secretsEnvPath(), `export GH_TOKEN=ghp-secret-in-a-bad-line\nGH_TOKEN=ghp-keep\n`);

  const errors: string[] = [];
  const real = console.error;
  console.error = (msg: unknown) => void errors.push(String(msg));

  try {
    readGhToken();
  } finally {
    console.error = real;
  }

  assert.equal(errors.length, 1, 'the dropped line was not reported');
  assert.match(errors[0] ?? '', /line 1/);
  assert.doesNotMatch(errors[0] ?? '', /ghp-secret-in-a-bad-line/);
});

/**
 * The paired control. A reader that logged every line would pass the test
 * above on its first assertion and flood an operator's terminal with one
 * complaint per blank line.
 */
test('a blank line is not reported as unparseable', () => {
  writeFileSync(secretsEnvPath(), `GH_TOKEN=ghp-blanks\n\n\n`);

  const errors: string[] = [];
  const real = console.error;
  console.error = (msg: unknown) => void errors.push(String(msg));

  try {
    assert.equal(readGhToken(), 'ghp-blanks');
  } finally {
    console.error = real;
  }

  assert.deepEqual(errors, []);
});
