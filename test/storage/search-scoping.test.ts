import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../../src/storage/db.js';
import * as dao from '../../src/storage/dao.js';

/**
 * 🛑 `search` READ EVERY DM AND EVERY ROOM, WHILE ITS DESCRIPTION SAID
 * "across every room and DM YOU CAN SEE".
 *
 * `target` is a filter the caller supplies, not an authorization check, so an
 * agent could read DMs it was not party to and rooms it never joined —
 * including ones it had been booted from. Found by claude1 reviewing #102.
 * lee ruled the CODE was wrong, not the description.
 *
 * ⚠️ THE HTTP ROUTE IS DELIBERATELY UNSCOPED and that is not the same defect.
 * `/api/search` is lee's own UI on `127.0.0.1` behind the DNS-rebinding guard,
 * so it passes no caller. The scope is opt-in for exactly that reason.
 */

const NOW = Date.now();

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  for (const h of ['claude1', 'claude2', 'lee']) {
    dao.upsertAgent(db, { handle: h, pid: 1, session_id: h, display_name: h, metadata: {} });
  }

  return db;
}

const dm = (db: DatabaseSync, from: string, to: string, body: string) =>
  dao.insertMessage(db, { from, to, body, kind: 'chat' });

const bodies = (r: { hits: Array<{ body: string }> }) => r.hits.map((h) => h.body).sort();

test('🛑 a caller cannot see a DM it is not a party to', () => {
  const db = freshDb();
  dm(db, 'claude1', 'lee', 'SECRET between claude1 and lee');
  dm(db, 'claude2', 'lee', 'SECRET from claude2');

  const mine = dao.searchMessages(db, { pattern: '%SECRET%', limit: 50, caller: 'claude2' });

  assert.deepEqual(bodies(mine), ['SECRET from claude2']);
});

/** The control. Without it, a scope that returned NOTHING would also pass. */
test('a caller sees its own DMs in BOTH directions', () => {
  const db = freshDb();
  dm(db, 'claude2', 'lee', 'TOPIC I sent');
  dm(db, 'lee', 'claude2', 'TOPIC I received');
  dm(db, 'claude1', 'lee', 'TOPIC between the other two');

  const mine = dao.searchMessages(db, { pattern: '%TOPIC%', limit: 50, caller: 'claude2' });

  assert.deepEqual(bodies(mine), ['TOPIC I received', 'TOPIC I sent']);
});

test('🛑 a caller cannot see a room it never joined', () => {
  const db = freshDb();
  dao.joinRoom(db, '#private', 'claude1');
  dm(db, 'claude1', '#private', 'MARKER in a room claude2 never joined');

  const seen = dao.searchMessages(db, { pattern: '%MARKER%', limit: 50, caller: 'claude2' });

  assert.deepEqual(bodies(seen), []);
});

test('a caller sees a room it DID join', () => {
  const db = freshDb();
  dao.joinRoom(db, '#shared', 'claude1');
  dao.joinRoom(db, '#shared', 'claude2');
  dm(db, 'claude1', '#shared', 'MARKER in a room we both joined');

  const seen = dao.searchMessages(db, { pattern: '%MARKER in%', limit: 50, caller: 'claude2' });

  assert.deepEqual(bodies(seen), ['MARKER in a room we both joined']);
});

/**
 * 🛑 BOOTED IS THE CASE THAT SEPARATES "scoped" FROM "scoped ONCE". A check
 * written against room history rather than current membership would pass every
 * test above and still leak here.
 */
test('🛑 a caller booted from a room stops seeing it', () => {
  const db = freshDb();
  dao.joinRoom(db, '#shared', 'claude1');
  dao.joinRoom(db, '#shared', 'claude2');
  dm(db, 'claude1', '#shared', 'MARKER said while claude2 was a member');

  assert.deepEqual(
    bodies(dao.searchMessages(db, { pattern: '%MARKER%', limit: 50, caller: 'claude2' })),
    ['MARKER said while claude2 was a member'],
    'the fixture never worked, so the assertion below proves nothing',
  );

  dao.bootFromRoom(db, '#shared', 'claude2');

  assert.deepEqual(bodies(dao.searchMessages(db, { pattern: '%MARKER%', limit: 50, caller: 'claude2' })), []);
});

/**
 * 🟡 from the same review: `to_handle = ?` is one-directional, so a peer target
 * returned only the caller's own half of the thread.
 */
test('a peer target returns BOTH halves of the thread, not just one', () => {
  const db = freshDb();
  dm(db, 'claude2', 'claude1', 'THREAD I sent to claude1');
  dm(db, 'claude1', 'claude2', 'THREAD claude1 sent to me');
  dm(db, 'claude2', 'lee', 'THREAD to someone else');

  const seen = dao.searchMessages(db, {
    pattern: '%THREAD%',
    target: 'claude1',
    limit: 50,
    caller: 'claude2',
  });

  // Sorted, so the capital I sorts before the lower-case c.
  assert.deepEqual(bodies(seen), ['THREAD I sent to claude1', 'THREAD claude1 sent to me']);
});

test('a room target still scopes to that one room', () => {
  const db = freshDb();
  dao.joinRoom(db, '#a', 'claude2');
  dao.joinRoom(db, '#b', 'claude2');
  dm(db, 'claude1', '#a', 'WORD in a');
  dm(db, 'claude1', '#b', 'WORD in b');

  const seen = dao.searchMessages(db, { pattern: '%WORD%', target: '#a', limit: 50, caller: 'claude2' });

  assert.deepEqual(bodies(seen), ['WORD in a']);
});

/**
 * 🛑 THE UNSCOPED PATH MUST KEEP WORKING. `/api/search` passes no caller, and a
 * scope applied unconditionally would empty lee's own UI.
 */
test('omitting the caller searches everything, which is what the HTTP route needs', () => {
  const db = freshDb();
  dao.joinRoom(db, '#private', 'claude1');
  dm(db, 'claude1', '#private', 'MARKER in a room');
  dm(db, 'claude1', 'lee', 'MARKER in a DM');

  const seen = dao.searchMessages(db, { pattern: '%MARKER%', limit: 50 });

  assert.deepEqual(bodies(seen), ['MARKER in a DM', 'MARKER in a room']);
});

/**
 * 🟡 from the same review: `truncated` was `hits.length === limit`, so an exact
 * hit count reported as truncated.
 */
test('🟡 truncated is FALSE when the hit count exactly equals the limit', () => {
  const db = freshDb();
  for (let i = 0; i < 3; i++) dm(db, 'claude2', 'lee', `EXACT ${i}`);

  const r = dao.searchMessages(db, { pattern: '%EXACT%', limit: 3, caller: 'claude2' });

  assert.equal(r.hits.length, 3);
  assert.equal(r.truncated, false, 'an exact count was reported as capped');
});

test('truncated is TRUE when there is at least one more row than the limit', () => {
  const db = freshDb();
  for (let i = 0; i < 4; i++) dm(db, 'claude2', 'lee', `EXACT ${i}`);

  const r = dao.searchMessages(db, { pattern: '%EXACT%', limit: 3, caller: 'claude2' });

  assert.equal(r.hits.length, 3, 'the extra probe row must not be returned to the caller');
  assert.equal(r.truncated, true);
});

/**
 * 🛑 DECIDED by lee, 2026-11-04: *"no, the should be able to see room history
 * after joining"*.
 *
 * So `search` and `room_inbox` differ ON PURPOSE, and the split is their job:
 * `room_inbox` is unread DELIVERY and anchors its watermark at the join so a
 * new member is not flooded; `search` is a deliberate LOOKUP and reading the
 * room's history is the whole point of it.
 *
 * ⚠️ THIS TEST EXISTS BECAUSE NEITHER DIRECTION WAS COVERED. Every other room
 * test here posts AFTER the join, so all of them were blind to this either
 * way. Raised by claude1; without a test the ruling is one refactor from being
 * silently reversed.
 */
test('🛑 a member CAN search what was said in a room before they joined', () => {
  const db = freshDb();
  dao.joinRoom(db, '#shared', 'claude1');
  const before = dm(db, 'claude1', '#shared', 'HERITAGE said before claude2 arrived');
  dao.joinRoom(db, '#shared', 'claude2');
  const after = dm(db, 'claude1', '#shared', 'HERITAGE said after claude2 arrived');

  // 🛑 THE TIMES ARE SET BY HAND, AND THE FIRST VERSION OF THIS TEST WAS
  // VACUOUS WITHOUT IT. `insertMessage` and `joinRoom` both stamp `Date.now()`,
  // so in one millisecond every row shares a timestamp and `sent_at >=
  // joined_at` holds for the pre-join message too. Injecting a `joined_at`
  // floor — the policy lee ruled against — left the test GREEN.
  db.prepare('UPDATE messages SET sent_at = ? WHERE id = ?').run(1_000, before.id);
  db.prepare('UPDATE room_members SET joined_at = ? WHERE room_name = ? AND handle = ?').run(2_000, '#shared', 'claude2');
  db.prepare('UPDATE messages SET sent_at = ? WHERE id = ?').run(3_000, after.id);

  assert.deepEqual(bodies(dao.searchMessages(db, { pattern: '%HERITAGE%', limit: 50, caller: 'claude2' })), [
    'HERITAGE said after claude2 arrived',
    'HERITAGE said before claude2 arrived',
  ]);
});

/** The control: a non-member still sees neither, so the test above is not vacuous. */
test('a non-member sees neither the pre-join nor the post-join message', () => {
  const db = freshDb();
  dao.joinRoom(db, '#shared', 'claude1');
  dm(db, 'claude1', '#shared', 'HERITAGE one');
  dm(db, 'claude1', '#shared', 'HERITAGE two');

  assert.deepEqual(bodies(dao.searchMessages(db, { pattern: '%HERITAGE%', limit: 50, caller: 'claude2' })), []);
});
