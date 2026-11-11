import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrate, SCHEMA_VERSION } from '../../src/storage/db.js';
import * as dao from '../../src/storage/dao.js';

/**
 * #138 — a send reported an id for a row that was never written.
 *
 * 🛑 THE PAIR OF NUMBERS IS THE DIAGNOSIS, NOT EITHER ONE ALONE.
 * `sqlite_sequence.seq` is the AUTOINCREMENT high-water mark, so comparing it
 * to `MAX(id)` separates "no INSERT was ever attempted" from "one was
 * attempted and rolled back". On the day, both sat at 13504 while three sends
 * claimed 13505-13508, which is what ruled out a rollback.
 */

function freshDb() {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  return db;
}

test('🛑 an empty messages table reports both marks as null instead of throwing', () => {
  // sqlite_sequence has NO ROW for a table until its first insert, so a naive
  // read of `.seq` throws on a fresh database — the one state every new
  // install is in.
  const db = freshDb();

  const health = dao.busHealth(db);

  assert.equal(health.max_id, null);
  assert.equal(health.autoincrement_seq, null);
  assert.equal(health.schema_version, SCHEMA_VERSION);
});

test('both marks equal the last inserted id when the table is intact', () => {
  const db = freshDb();
  dao.insertMessage(db, { from: 'a', to: 'b', body: 'one' });
  const last = dao.insertMessage(db, { from: 'a', to: 'b', body: 'two' });

  const health = dao.busHealth(db);

  assert.equal(health.max_id, last.id);
  assert.equal(health.autoincrement_seq, last.id);
});

test('🛑 max_id falls BELOW the sequence once a row is removed, which is what a rollback looks like', () => {
  // The signature that distinguishes a row inserted-then-gone from one never
  // attempted. #138's evidence turns on this: the sequence had NOT advanced,
  // so nothing was ever inserted.
  const db = freshDb();
  dao.insertMessage(db, { from: 'a', to: 'b', body: 'one' });
  const last = dao.insertMessage(db, { from: 'a', to: 'b', body: 'two' });
  db.prepare('DELETE FROM messages WHERE id = ?').run(last.id);

  const health = dao.busHealth(db);

  assert.equal(health.max_id, last.id - 1);
  assert.equal(health.autoincrement_seq, last.id);
  assert.ok(health.max_id < health.autoincrement_seq);
});

test('🛑 deleting every message leaves max_id null beside a LIVE high-water mark', () => {
  // The state `healthReading` used to call "no message has ever been written".
  // `sqlite_sequence` survives a DELETE, so an emptied table is distinguishable
  // from a fresh one — and `deleteDmMessages` is a production path to it.
  const db = freshDb();
  dao.insertMessage(db, { from: 'a', to: 'b', body: 'one' });
  const last = dao.insertMessage(db, { from: 'a', to: 'b', body: 'two' });

  dao.deleteDmMessages(db, 'a', 'b');

  const health = dao.busHealth(db);

  assert.equal(health.max_id, null);
  assert.equal(health.autoincrement_seq, last.id);
});
