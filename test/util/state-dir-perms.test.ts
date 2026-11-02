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
/**
 * 🛑 BOTH HALVES ARE LOAD-BEARING, because the three files reach `openDb` in
 * two different states and one guard cannot cover both.
 *
 * `chat.db` SURVIVES a close, so it is re-loosened to 0644 — that is the
 * pre-existing install the ticket is about. `-wal` and `-shm` are DELETED on a
 * clean close and re-created by SQLite at the umask mode, so `umask 000` is
 * what stops the environment satisfying the assertion for them.
 *
 * Without the umask half this test passed with `tightenDbFiles()` deleted
 * under `umask 077`. Measured, and found by claude1 reviewing the branch.
 */
test('🚨 the database, its WAL and its shm are all 0600 after open', async () => {
  const { openDb } = await import('../../src/storage/db.js');
  const paths = ['', '-wal', '-shm'].map((suffix) => `${dbPath()}${suffix}`);
  const [main, wal, shm] = paths as [string, string, string];

  openDb().close();

  assert.ok(existsSync(main), 'chat.db survived the close, so re-loosening it is possible');
  chmodSync(main, 0o644);
  assert.equal(modeOf(main), 0o644, 'chat.db is group-readable going into the re-open');
  // 🛑 Print the denominator: these two are gone, so ONLY the umask protects
  // them and a `chmod` here would be a no-op on a path that does not exist.
  assert.equal(existsSync(wal), false, '-wal is absent, so SQLite re-creates it');
  assert.equal(existsSync(shm), false, '-shm is absent, so SQLite re-creates it');

  const db = withUmask(0o000, () => openDb());

  try {
    for (const path of paths) {
      assert.ok(existsSync(path), `${path} exists, so the assertion is not vacuous`);
      assert.equal(modeOf(path), STATE_FILE_MODE, `${path} is owner-only`);
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

/**
 * 🛑 `stateDir()` IS THE ONLY PLACE THAT MAY NAME `.chat-mcp`.
 *
 * `web-url` was built with `join(homedir(), '.chat-mcp', …)`, so under
 * CHAT_MCP_HOME it created a SECOND state directory at the umask mode and
 * nothing chmodded it. A per-file mode cannot catch that class; only the
 * single chokepoint can. Found by claude1 reviewing this branch.
 */
test("🚨 no file but paths.ts builds a '.chat-mcp' path of its own", async () => {
  const { execFileSync } = await import('node:child_process');
  const root = new URL('../../src', import.meta.url).pathname;

  const hits = execFileSync('grep', ['-rn', "\\.chat-mcp", root], { encoding: 'utf8' })
    .split('\n')
    .filter((line) => line.length > 0)
    // A comment or an error message may name the path; only code that BUILDS
    // one is the defect, and every such line goes through join() or a literal
    // concatenation with homedir().
    .filter((line) => /homedir\(\)/.test(line))
    .filter((line) => !line.includes('/util/paths.ts'));

  assert.deepEqual(hits, [], `these build their own state path:\n${hits.join('\n')}`);
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
