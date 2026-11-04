import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../../src/storage/db.js';
import * as dao from '../../src/storage/dao.js';
import { parseSearch } from '../../src/search/query.js';

/**
 * 🛑 THE HAZARD #102 NAMES, AS A TEST.
 *
 * `room_inbox` advances a per-member read watermark. A search routed through
 * it would silently mark messages read, which is exactly what makes
 * re-reading a room expensive today — so the fix would have reintroduced the
 * problem it was built to solve.
 *
 * 🛑 AND A WRONG SEARCH RETURNS RESULTS, so it looks like it worked. The
 * escaping cases below are the ones where the symptom is only a longer or
 * shorter list.
 */

function dbWithRoom(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  for (const h of ['claude1', 'claude2']) {
    dao.upsertAgent(db, { handle: h, pid: 1, session_id: h, display_name: h, metadata: {} });
  }
  dao.joinRoom(db, '#leagues', 'claude1');
  dao.joinRoom(db, '#leagues', 'claude2');

  return db;
}

const say = (db: DatabaseSync, from: string, to: string, body: string) =>
  dao.insertMessage(db, { from, to, body, kind: 'chat' });

const find = (db: DatabaseSync, q: string, target?: string) => {
  const p = parseSearch({ q, target });
  assert.equal(p.ok, true, `query ${JSON.stringify(q)} was refused`);
  if (!p.ok) throw new Error('unreachable');

  // `.hits` since #102's scoping fix: the result also carries `truncated`.
  return dao.searchMessages(db, { pattern: p.pattern, target: p.target, limit: p.limit }).hits;
};

test('🛑 a search does NOT advance any read watermark', () => {
  const db = dbWithRoom();
  say(db, 'claude1', '#leagues', 'CLAIMING reset-and-test.sh for the gate');
  say(db, 'claude1', '#leagues', 'DONE, gate was green');

  const before = db.prepare('SELECT handle, last_read_id FROM room_reads ORDER BY handle').all();

  const hits = find(db, 'gate', '#leagues');
  assert.equal(hits.length, 2, 'the fixture has to actually match, or this test proves nothing');

  const after = db.prepare('SELECT handle, last_read_id FROM room_reads ORDER BY handle').all();

  assert.deepEqual(after, before, 'searching moved a read pointer');
});

test('a search does not mark a DM read either', () => {
  const db = dbWithRoom();
  say(db, 'claude1', 'claude2', 'the gate is yours');

  const before = db.prepare('SELECT id, read_at FROM messages ORDER BY id').all();
  assert.equal(find(db, 'gate').length, 1);
  const after = db.prepare('SELECT id, read_at FROM messages ORDER BY id').all();

  assert.deepEqual(after, before, 'searching set read_at');
});

test('🛑 a query containing % finds the LITERAL percent, not every message', () => {
  const db = dbWithRoom();
  say(db, 'claude1', '#leagues', 'the gauge reads 100% which is the clamp');
  say(db, 'claude1', '#leagues', 'nothing to do with percentages');
  say(db, 'claude1', '#leagues', 'also unrelated');

  const hits = find(db, '100%');

  // 3 rows exist. An unescaped pattern would return all three and read as a
  // very popular term, which is why the denominator is asserted.
  assert.equal(hits.length, 1, `expected 1 of 3, got ${hits.length}`);
  assert.match(hits[0]?.body ?? '', /100%/);
});

test('🛑 a query containing _ finds the LITERAL underscore', () => {
  const db = dbWithRoom();
  say(db, 'claude1', '#leagues', 'the column is context_used');
  say(db, 'claude1', '#leagues', 'the column is contextXused');

  const hits = find(db, 'context_used');

  assert.equal(hits.length, 1, 'the underscore matched any character');
});

test('the target scopes the search, and the unscoped form reaches both', () => {
  const db = dbWithRoom();
  say(db, 'claude1', '#leagues', 'gate in the room');
  say(db, 'claude1', 'claude2', 'gate in a DM');

  assert.equal(find(db, 'gate', '#leagues').length, 1);
  assert.equal(find(db, 'gate', 'claude2').length, 1);
  assert.equal(find(db, 'gate').length, 2);
});

test('results come back newest first, because the recent decision is the one being hunted', () => {
  const db = dbWithRoom();
  const first = say(db, 'claude1', '#leagues', 'gate one');
  const second = say(db, 'claude1', '#leagues', 'gate two');

  const hits = find(db, 'gate');

  assert.deepEqual(hits.map((h) => h.id), [second.id, first.id]);
});

test('the limit is honoured, and it is the parsed one', () => {
  const db = dbWithRoom();
  for (let i = 0; i < 5; i++) say(db, 'claude1', '#leagues', `gate ${i}`);

  const p = parseSearch({ q: 'gate', limit: 2 });
  assert.equal(p.ok, true);
  if (!p.ok) throw new Error('unreachable');

  assert.equal(dao.searchMessages(db, { pattern: p.pattern, target: p.target, limit: p.limit }).hits.length, 2);
});

test('a term that matches nothing returns an empty list rather than throwing', () => {
  const db = dbWithRoom();
  say(db, 'claude1', '#leagues', 'the gate is free');

  assert.deepEqual(find(db, 'zzzzz'), []);
});

test('the match is case-insensitive, as LIKE is', () => {
  const db = dbWithRoom();
  say(db, 'claude1', '#leagues', 'CLAIMING the stack');

  assert.equal(find(db, 'claiming').length, 1);
});
