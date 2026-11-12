import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
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

const { openDb, identityFor, identityOf } = await import('../../src/storage/db.js');
const { dbPath } = await import('../../src/util/paths.js');

test.after(() => rmSync(home, { recursive: true, force: true }));

test('🛑 every path this file writes to is inside the temp dir, not the live state dir', () => {
  // The control for the whole file. Without it the containment is inferred
  // from paths.ts rather than tested, and the swap tests below rename and
  // unlink whatever `dbPath()` resolves to.
  assert.ok(
    dbPath().startsWith(home),
    `dbPath() escaped the temp dir: ${dbPath()} is not under ${home}`,
  );
});

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
  const moved = `${dbPath()}.moved`;
  try {
    const recorded = identityFor(db);
    assert.ok(recorded);

    renameSync(dbPath(), moved);
    writeFileSync(dbPath(), '');
    const afterSwap = statSync(dbPath());

    assert.notEqual(afterSwap.ino, recorded.ino);
  } finally {
    // Restored, or every later test inherits this test's empty stand-in file.
    db.close();
    rmSync(dbPath(), { force: true });
    renameSync(moved, dbPath());
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

test('a MISSING file reads as null, which identityReading turns into the loud answer', () => {
  const gone = `${dbPath()}.gone`;
  renameSync(dbPath(), gone);
  try {
    assert.equal(identityOf(dbPath()), null);
  } finally {
    renameSync(gone, dbPath());
  }
});

test('🛑 a parent that stopped being a DIRECTORY also reads as null, not as a fault', () => {
  // ENOTDIR, reached one level up: the state directory replaced by a regular
  // file. There is no database at this path, as firmly as ENOENT means it.
  // Rethrowing would kill the whole health tool at the moment the state
  // directory is the thing that broke.
  const notDir = join(home, 'notadir');
  writeFileSync(notDir, 'i am a file');
  try {
    assert.equal(identityOf(join(notDir, 'chat.db')), null);
  } finally {
    rmSync(notDir, { force: true });
  }
});

test('🛑 an error that is NOT a missing file is RETHROWN, and the errno is named', () => {
  // A chmod mistake or a symlink cycle is a fault of its own. Collapsing it to
  // null would make `health` state "the file no longer exists", which is
  // confidently false. A self-referential symlink gives ELOOP on stat.
  const loop = join(home, 'loop.db');
  try {
    symlinkSync(loop, loop);
    // Asserting ELOOP by name, not merely "not ENOENT" — that weaker predicate
    // passes on a TypeError and so could not have failed.
    assert.throws(
      () => identityOf(loop),
      (err: unknown) => (err as NodeJS.ErrnoException).code === 'ELOOP',
    );
  } finally {
    rmSync(loop, { force: true });
  }
});

test('⚠️ control — a real directory in the path does NOT read as missing', () => {
  // The positive half. Without it, an identityOf that returned null for
  // everything would pass every assertion above.
  const nested = join(home, 'nested');
  mkdirSync(nested, { recursive: true });
  const file = join(nested, 'chat.db');
  writeFileSync(file, '');
  try {
    assert.deepEqual(identityOf(file), {
      dev: statSync(file).dev,
      ino: statSync(file).ino,
    });
  } finally {
    rmSync(nested, { recursive: true, force: true });
  }
});
