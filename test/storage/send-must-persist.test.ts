import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Point CHAT_MCP_HOME at a scratch dir BEFORE importing anything that reads it.
process.env.CHAT_MCP_HOME = join(mkdtempSync(join(tmpdir(), 'chat-mcp-persist-')), 'state');

const { migrate, openDb, verifierFor } = await import('../../src/storage/db.js');
const { dbPath } = await import('../../src/util/paths.js');
const dao = await import('../../src/storage/dao.js');

/**
 * #138 slice 2 — a send that persists nothing must THROW, not return an id.
 *
 * 🛑 `lastInsertRowid` IS PER-CONNECTION, NOT PER-TABLE. A statement that
 * inserts nothing still hands back the rowid of whatever that connection
 * inserted last, from any table. A reported id is the only signal a send
 * returns, so that receipt is fiction.
 *
 * Both fixtures are real SQLite triggers rather than stubs.
 */

/** A rowid no `messages` id can collide with, so a stale receipt is unmistakable. */
const FOREIGN_ROWID = 777;

function freshDb() {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  return db;
}

/**
 * Fixture A — the insert vanishes and `changes` is 0, with the connection's
 * last rowid pointing at another table.
 */
function swallowMessageInserts(db: DatabaseSync) {
  db.exec('CREATE TRIGGER swallow BEFORE INSERT ON messages BEGIN SELECT RAISE(IGNORE); END');
  db.prepare('INSERT INTO claims (id, resource, holder, claimed_at, expires_at) VALUES (?, ?, ?, ?, ?)').run(
    FOREIGN_ROWID,
    'r',
    'a',
    1,
    2,
  );
}

/** Fixture B — the insert COUNTS, so `changes` is 1, but the row does not survive it. */
function deleteMessagesOnInsert(db: DatabaseSync) {
  db.exec('CREATE TRIGGER vanish AFTER INSERT ON messages BEGIN DELETE FROM messages WHERE id = NEW.id; END');
}

test('🛑 a send that changes no rows throws instead of returning an id', () => {
  const db = freshDb();
  swallowMessageInserts(db);

  assert.throws(() => dao.insertMessage(db, { from: 'a', to: 'b', body: 'vanishes' }), {
    name: 'MessageNotPersistedError',
    reason: 'no-rows-changed',
  });

  assert.equal(dao.busHealth(db).max_id, null, 'nothing was written, which is the premise');
});

test('🛑 fixture A is NOT vacuous — the id it would have returned belongs to another table', () => {
  // Without the guard this send returns FOREIGN_ROWID, an id belonging to
  // `claims`. Asserting that number reaches the error is what proves the test
  // exercises the defect rather than an ordinary SQLite failure.
  const db = freshDb();
  swallowMessageInserts(db);

  assert.throws(() => dao.insertMessage(db, { from: 'a', to: 'b', body: 'vanishes' }), {
    claimedId: FOREIGN_ROWID,
  });
});

test('🛑 a send whose row does not survive the write throws on the read-back', () => {
  // The branch `changes === 1` cannot see. The insert really happened and was
  // really counted; the row is still gone.
  const db = freshDb();
  deleteMessagesOnInsert(db);

  assert.throws(() => dao.insertMessage(db, { from: 'a', to: 'b', body: 'gone' }), {
    name: 'MessageNotPersistedError',
    reason: 'row-absent-on-reread',
  });
});

test('a healthy send still returns its id and the row is readable', () => {
  // The positive control. A guard that rejects everything passes all three above.
  const db = freshDb();

  const sent = dao.insertMessage(db, { from: 'a', to: 'b', body: 'lands' });

  assert.equal(typeof sent.id, 'number');
  assert.equal(dao.busHealth(db).max_id, sent.id);
});

test('🛑 openDb pairs a SECOND connection with the handle, and it sees committed writes', (t) => {
  const db = openDb();
  // 🛑 IN `t.after`, NEVER AFTER THE ASSERTIONS. A connection left open keeps
  // `-wal` on disk and fails the close test further down this file.
  t.after(() => db.close());
  const witness = verifierFor(db);

  assert.ok(witness, 'openDb registered no verifier, so every read-back is the writer marking its own work');
  assert.notEqual(witness, db, 'the verifier must not be the connection that wrote the row');

  const sent = dao.insertMessage(db, { from: 'a', to: 'b', body: 'crosses connections' });

  const seen = witness.prepare('SELECT from_handle FROM messages WHERE id = ?').get(sent.id);
  assert.equal((seen as { from_handle: string } | undefined)?.from_handle, 'a');
});

test('🛑 insertMessage reads back through the VERIFIER, not the writer', (t) => {
  // Non-vacuous proof that the second connection is the one consulted. With the
  // verifier closed the send must fail — while the primary can still read the
  // row, so the failure came from the witness rather than from the write.
  const db = openDb();
  t.after(() => db.close());
  const witness = verifierFor(db);
  assert.ok(witness);
  witness.close();

  assert.throws(() => dao.insertMessage(db, { from: 'a', to: 'b', body: 'no witness' }));

  const maxId = dao.busHealth(db).max_id;
  assert.ok(maxId !== null, 'the write itself landed, which is what makes this the witness failing');
});

test('🛑 closing the handle closes its verifier, so the WAL does not outlive the close', () => {
  // A second live connection keeps `-wal` and `-shm` on disk past a clean
  // close, and those hold the newest traffic. `state-dir-perms` is what caught
  // this when the verifier closed with nothing.
  const db = openDb();
  const witness = verifierFor(db);
  assert.ok(witness);

  db.close();

  assert.throws(() => witness.prepare('SELECT 1').get(), /not open/i);
  // The file is the claim, not the error text. SQLite only removes these two on
  // a close with no connection left.
  assert.equal(existsSync(`${dbPath()}-wal`), false, '-wal outlived the close');
  assert.equal(existsSync(`${dbPath()}-shm`), false, '-shm outlived the close');
});

/**
 * 🛑 THE FALLBACK IN `insertMessage` ASSUMES `openDb` IS THE ONLY PLACE
 * PRODUCTION OPENS A DATABASE. A second call site would get the writing
 * connection as its own witness, silently, and nothing else would notice.
 */
test('🛑 src/ opens a database in exactly one place, so every handle gets a verifier', () => {
  const files = execFileSync('git', ['ls-files', 'src'], { encoding: 'utf8' })
    .split('\n')
    .filter((f) => f.endsWith('.ts'));
  // Denominator: a listing that matched nothing would otherwise pass.
  assert.ok(files.length >= 40, `found only ${files.length} source files`);

  const openers = files.filter((f) => readFileSync(f, 'utf8').includes('new DatabaseSync('));

  assert.deepEqual(openers, ['src/storage/db.ts']);
});
