import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), 'chat-mcp-mounts-'));

const { registerMount, readMounts, mountsFor, mountsPath, containerPathFor } = await import(
  '../../src/supervise/mounts.js'
);
const { stateDir } = await import('../../src/util/paths.js');

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

test('containerPathFor returns /mnt/{key}', () => {
  assert.equal(containerPathFor('local-context'), '/mnt/local-context');
});

test('containerPathFor works for different keys', () => {
  assert.equal(containerPathFor('memory'), '/mnt/memory');
});

/**
 * 🛑 #183, SECOND SURFACE. Found by claude2 reviewing the first fix, which
 * guarded `registerProject` and the project mount and stopped there.
 *
 * An extra mount is bind-mounted with NO `:ro`, so a mount key pointed above
 * the state directory carries `chat.db` and the manifest in read-write exactly
 * as the project tree did.
 */
test('🛑 a mount ABOVE the state directory is refused', () => {
  assert.throws(() => registerMount('claude1', 'evil', dirname(stateDir())), /state directory/);
});

/** A control: an ordinary directory still registers. */
test('and an ordinary directory still registers', () => {
  assert.deepEqual(registerMount('claude7', 'ok', HOST_DIR), { ok: resolve(HOST_DIR) });
});
