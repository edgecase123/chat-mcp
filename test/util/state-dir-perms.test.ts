import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Point CHAT_MCP_HOME at a scratch dir BEFORE importing anything that reads it.
process.env.CHAT_MCP_HOME = join(mkdtempSync(join(tmpdir(), 'chat-mcp-perms-')), 'state');

const {
  ensureStateDir,
  stateDir,
  dbPath,
  notifyPathFor,
  chmodVerified,
  STATE_DIR_MODE,
  STATE_FILE_MODE,
} = await import('../../src/util/paths.js');

const modeOf = (p: string) => statSync(p).mode & 0o777;

const withUmask = <T>(mask: number, fn: () => T): T => {
  const previous = process.umask(mask);
  try {
    return fn();
  } finally {
    process.umask(previous);
  }
};

/**
 * 🚨 EVERY MESSAGE THE BUS HAS EVER CARRIED LIVES IN THIS DIRECTORY.
 *
 * Until this guard existed it was 755, so any other account on the host read
 * the whole database with `cat`. No handle, no socket, no peer status.
 */
test('🚨 the state directory is 0700', () => {
  ensureStateDir();

  assert.equal(modeOf(stateDir()), STATE_DIR_MODE);
});

/**
 * ⚠️ `mkdirSync(dir, { mode })` DOES NOT CHANGE AN EXISTING DIRECTORY, and
 * every install that predates this guard already has one at 755. The fixture
 * pre-creates it WIDE OPEN and asserts that, because a fixture that creates it
 * fresh under a tight umask passes with the chmod deleted.
 */
test('🚨 an ALREADY EXISTING wide-open state directory is tightened', () => {
  mkdirSync(stateDir(), { recursive: true });
  chmodSync(stateDir(), 0o777);
  assert.equal(modeOf(stateDir()), 0o777, 'the fixture is actually wide open before the call');

  ensureStateDir();

  assert.equal(modeOf(stateDir()), STATE_DIR_MODE);
});

/**
 * Negative control. Under a permissive umask a `mkdir` mode argument alone
 * lands at 777, so this pins the chmod rather than the environment.
 */
test('the 0700 comes from the chmod, not from the umask', () => {
  withUmask(0o000, () => {
    mkdirSync(stateDir(), { recursive: true });
    chmodSync(stateDir(), 0o777);

    ensureStateDir();

    assert.equal(modeOf(stateDir()), STATE_DIR_MODE);
  });
});

/**
 * 🛑 A SILENT no-op IS THE FAILURE THIS CATCHES. On WSL a CHAT_MCP_HOME under
 * `/mnt/c` sits on DrvFs, which carries no POSIX mode unless the mount says
 * `metadata`. `chmodSync` there returns success and changes nothing, so the
 * fix would report green while storing every message readable.
 */
test('🚨 chmodVerified THROWS when the chmod did not take', (t) => {
  if (process.platform === 'win32') return t.skip('modes are not enforceable on win32');

  const dir = mkdtempSync(join(tmpdir(), 'chat-mcp-noop-'));
  // Stand in for a filesystem that ignores the mode: ask for a mode, then
  // report a different one back. Only the read-back can tell the difference.
  const original = statSync(dir).mode;

  assert.throws(
    () => chmodVerified(dir, 0o700, () => ({ ...statSync(dir), mode: original | 0o055 })),
    /did not take/,
  );
});

test('chmodVerified is silent when the mode landed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chat-mcp-ok-'));

  chmodVerified(dir, STATE_DIR_MODE);

  assert.equal(modeOf(dir), STATE_DIR_MODE);
});

/**
 * 🛑 THE WAL IS THE FILE WORTH READING. It holds the most recent messages, and
 * SQLite creates it itself at the umask mode. A 0600 database beside a 0644
 * WAL still discloses the newest traffic.
 */
test('🚨 the database, its WAL and its shm are all 0600 after open', async () => {
  const { openDb } = await import('../../src/storage/db.js');
  const db = openDb();

  try {
    for (const suffix of ['', '-wal', '-shm']) {
      const path = `${dbPath()}${suffix}`;
      assert.ok(existsSync(path), `${suffix || 'chat.db'} exists, so the assertion is not vacuous`);
      assert.equal(modeOf(path), STATE_FILE_MODE, `${suffix || 'chat.db'} is owner-only`);
    }
  } finally {
    db.close();
  }
});

/**
 * A notify file leaks the handle it is named for and the message metadata.
 *
 * 🛑 EACH WRITE SITE GETS ITS OWN TEST, AND EACH RE-LOOSENS THE FILE FIRST.
 * Two earlier cuts were vacuous. One called `writePrivateFileSync` directly and
 * proved the helper rather than any caller. The next drove `touch()` but let
 * the CONSTRUCTOR's own chmod satisfy the assertion, so it stayed green with
 * `touch()` reverted.
 */
test('🚨 the NotifyBus constructor leaves its notify file 0600', async () => {
  const { ensureNotifyDir } = await import('../../src/util/paths.js');
  const { NotifyBus } = await import('../../src/notify/bus.js');

  ensureNotifyDir();
  const path = notifyPathFor('perms-ctor');
  writeFileSync(path, 'pre-existing');
  chmodSync(path, 0o644);
  assert.equal(modeOf(path), 0o644, 'the fixture really is group-readable first');

  new NotifyBus('perms-ctor');

  assert.equal(modeOf(path), STATE_FILE_MODE);
});

test('🚨 touch() leaves its notify file 0600', async () => {
  const { ensureNotifyDir } = await import('../../src/util/paths.js');
  const { NotifyBus } = await import('../../src/notify/bus.js');

  ensureNotifyDir();
  const path = notifyPathFor('perms-touch');
  const bus = new NotifyBus('perms-touch');

  // 🛑 AFTER the constructor, so its chmod cannot satisfy this assertion.
  chmodSync(path, 0o644);
  assert.equal(modeOf(path), 0o644, 'the fixture is group-readable going into touch()');

  bus.touch({ id: 1, from: 'claude1', body: 'payload' });

  assert.equal(modeOf(path), STATE_FILE_MODE);
});

test('🚨 notifyPeer leaves the recipient notify file 0600', async () => {
  const { ensureNotifyDir } = await import('../../src/util/paths.js');
  const { notifyPeer } = await import('../../src/notify/bus.js');

  ensureNotifyDir();
  const path = notifyPathFor('perms-peer');
  writeFileSync(path, 'pre-existing');
  chmodSync(path, 0o644);
  assert.equal(modeOf(path), 0o644, 'the fixture really is group-readable first');

  notifyPeer('perms-peer', { id: 1, from: 'claude1', body: 'payload' });

  assert.equal(modeOf(path), STATE_FILE_MODE);
});
