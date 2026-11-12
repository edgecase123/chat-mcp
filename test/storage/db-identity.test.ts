import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * #138 — proof that the recorded identity DIVERGES on a swap.
 *
 * 🛑 THIS IS THE TEST THE PATH-BASED DESIGN COULD NOT PASS. The first cut read
 * the connection's file via `PRAGMA database_list`, which returns the path it
 * was opened on and therefore cannot change. Spiked and discarded before it
 * was built.
 *
 * ⚠️ `CHAT_MCP_HOME` is set BEFORE the import, because `openDb` resolves
 * `stateDir()` and would otherwise refuse under the test runner.
 */

const home = mkdtempSync(join(tmpdir(), 'chat-mcp-ident-'));
process.env.CHAT_MCP_HOME = home;

const { openDb, identityFor } = await import('../../src/storage/db.js');
const { dbPath } = await import('../../src/util/paths.js');

test('openDb records the device and inode of the file it actually opened', () => {
  const db = openDb();
  try {
    const recorded = identityFor(db);
    const onDisk = statSync(dbPath());

    assert.ok(recorded, 'openDb recorded no identity');
    assert.equal(recorded.dev, onDisk.dev);
    assert.equal(recorded.ino, onDisk.ino);
  } finally {
    db.close();
  }
});

test('🛑 swapping the file at the path makes the recorded inode diverge', () => {
  // The exact shape of #138: the path string never changes, so every
  // path-reporting instrument keeps answering "same file". The inode does not.
  const db = openDb();
  try {
    const recorded = identityFor(db);
    assert.ok(recorded);

    renameSync(dbPath(), `${dbPath()}.moved`);
    writeFileSync(dbPath(), '');
    const afterSwap = statSync(dbPath());

    assert.notEqual(afterSwap.ino, recorded.ino);
  } finally {
    db.close();
  }
});

test('a database that did not come from openDb has NO recorded identity', async () => {
  // `identityFor` must return undefined rather than a fabricated mark, so the
  // reading can say "not recorded" instead of claiming a match.
  const { DatabaseSync } = await import('node:sqlite');
  const bare = new DatabaseSync(':memory:');
  try {
    assert.equal(identityFor(bare), undefined);
  } finally {
    bare.close();
  }
});

const { currentIdentity } = await import('../../src/shim/tools/health.js');

test('a MISSING database file reads as null, which identityReading turns into the loud answer', () => {
  renameSync(dbPath(), `${dbPath()}.gone`);
  try {
    assert.equal(currentIdentity(), null);
  } finally {
    renameSync(`${dbPath()}.gone`, dbPath());
  }
});

test('🛑 an error that is NOT ENOENT is RETHROWN, never reported as a missing file', () => {
  // A chmod mistake or a symlink cycle is a fault of its own. Collapsing it to
  // null would make `health` state "the file no longer exists", which is
  // confidently false. A self-referential symlink gives ELOOP on stat.
  renameSync(dbPath(), `${dbPath()}.real`);
  symlinkSync(dbPath(), dbPath());
  try {
    // Asserting ELOOP by name, not merely "not ENOENT" — that weaker predicate
    // passes on a TypeError and so could not have failed.
    assert.throws(
      () => currentIdentity(),
      (err: unknown) => (err as NodeJS.ErrnoException).code === 'ELOOP',
    );
  } finally {
    rmSync(dbPath());
    renameSync(`${dbPath()}.real`, dbPath());
  }
});
