import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), 'chat-mcp-mounts-'));

const { registerMount, readMounts, mountsFor, mountsPath } = await import(
  '../../src/supervise/mounts.js'
);

const HOST_DIR = mkdtempSync(join(tmpdir(), 'chat-mcp-mount-src-'));

test('an unregistered handle has no mounts', () => {
  assert.deepEqual(mountsFor('nobody'), {});
});

test('registering a mount makes it readable by key', () => {
  registerMount('claude1', 'local-context', HOST_DIR);
  assert.deepEqual(mountsFor('claude1'), { 'local-context': HOST_DIR });
});

test('a second key for the same handle is additive', () => {
  const memDir = mkdtempSync(join(tmpdir(), 'chat-mcp-mount-mem-'));
  registerMount('claude1', 'memory', memDir);
  assert.deepEqual(mountsFor('claude1'), {
    'local-context': HOST_DIR,
    memory: memDir,
  });
});

test('registering the same key again overwrites it, not appends', () => {
  const replacement = mkdtempSync(join(tmpdir(), 'chat-mcp-mount-replace-'));
  registerMount('claude1', 'memory', replacement);
  assert.deepEqual(mountsFor('claude1')['memory'], replacement);
});

test('registering for a directory that does not exist throws', () => {
  assert.throws(
    () => registerMount('claude1', 'bogus', join(HOST_DIR, 'nope')),
    /no such directory/,
  );
});

test('a second handle is independent of the first', () => {
  const dir2 = mkdtempSync(join(tmpdir(), 'chat-mcp-mount-h2-'));
  registerMount('claude2', 'local-context', dir2);
  assert.deepEqual(mountsFor('claude1')['local-context'], HOST_DIR);
  assert.deepEqual(mountsFor('claude2'), { 'local-context': dir2 });
});

test('a malformed mounts.json reads as empty rather than throwing', async () => {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(mountsPath(), 'not json');
  assert.deepEqual(readMounts(), { agents: {} });
});
