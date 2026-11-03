import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../../src/storage/db.js';
import * as dao from '../../src/storage/dao.js';

/**
 * 🛑 RECOVERING ONE TRUNCATED MESSAGE COST A WHOLE UNREAD DUMP.
 *
 * `inbox` has `since_id`; `roomUnread` had only the watermark. An agent woken
 * with a body cut mid-sentence knows the id it wants and could not ask for it,
 * so it took every unread message in the room and had them all marked read.
 *
 * The floor is `MAX(watermark, sinceId)` — never a replacement. Below the
 * watermark it must not re-serve what was already read; above it, the skipped
 * range must stay unread, which is the half that fails invisibly.
 */

function roomWithTwoMembers(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  for (const h of ['me', 'other']) {
    dao.upsertAgent(db, { handle: h, pid: 1, session_id: h, display_name: h, metadata: {} });
    dao.joinRoom(db, '#r', h);
  }
  const newest = db
    .prepare("SELECT COALESCE(MAX(id), 0) AS n FROM messages WHERE to_handle = '#r'")
    .get() as unknown as { n: number };
  for (const h of ['me', 'other']) dao.advanceRoomRead(db, '#r', h, Number(newest.n));
  assert.equal(dao.roomUnreadCount(db, '#r', 'me'), 0, 'fixture starts clean');
  return db;
}

/** Four sibling posts, none read. Returns their ids in order. */
function fourPosts(db: DatabaseSync): number[] {
  return ['a', 'b', 'c', 'd'].map(
    (body) => dao.insertMessage(db, { from: 'other', to: '#r', body }).id,
  );
}

test('🚨 since_id above the watermark serves only what follows it', () => {
  const db = roomWithTwoMembers();
  try {
    const ids = fourPosts(db);

    const got = dao.roomUnread(db, '#r', 'me', 50, ids[1]);

    assert.deepEqual(got.map((m) => m.body), ['c', 'd']);
  } finally {
    db.close();
  }
});

/**
 * 🛑 EXCLUSIVE, MATCHING `pendingInbox`'s `id > since_id`. If `room_inbox`
 * were inclusive, an agent asking for the message after 100 would get 100
 * again and loop.
 */
test('🚨 since_id is exclusive, so the named id is NOT returned', () => {
  const db = roomWithTwoMembers();
  try {
    const ids = fourPosts(db);

    const got = dao.roomUnread(db, '#r', 'me', 50, ids[0]);

    assert.equal(got.some((m) => m.id === ids[0]), false, 'the named id must be excluded');
    assert.equal(got[0]?.body, 'b');
  } finally {
    db.close();
  }
});

/**
 * 🛑 THE FLOOR IS A MAX. A stale `since_id` below the watermark must not
 * resurrect messages the caller already consumed.
 */
test('🚨 since_id below the watermark does not re-serve read messages', () => {
  const db = roomWithTwoMembers();
  try {
    const ids = fourPosts(db);
    dao.advanceRoomRead(db, '#r', 'me', ids[2]);

    const got = dao.roomUnread(db, '#r', 'me', 50, 0);

    assert.deepEqual(got.map((m) => m.body), ['d'], 'watermark still wins over a lower since_id');
  } finally {
    db.close();
  }
});

/**
 * 🛑 THIS IS THE ASSERTION MOST LIKELY TO BE LEFT OUT, AND ITS ABSENCE IS
 * INVISIBLE. A targeted read must not mark the range it jumped over as read.
 */
test('🚨 a skipped range is STILL UNREAD after a since_id read', () => {
  const db = roomWithTwoMembers();
  try {
    const ids = fourPosts(db);

    dao.roomUnread(db, '#r', 'me', 50, ids[2]);

    assert.equal(dao.roomUnreadCount(db, '#r', 'me'), 4, 'a read alone never advances');
    assert.equal(
      dao.safeRoomAdvanceId(db, '#r', 'me', ids[2], [ids[3]]),
      undefined,
      'a gap above the watermark forbids any advance',
    );
  } finally {
    db.close();
  }
});

/**
 * The negative control for the guard above. With no gap, the watermark MUST
 * still advance, or an ordinary `room_inbox` call stops consuming anything.
 */
test('🚨 with no gap the watermark still advances, so ordinary reads still consume', () => {
  const db = roomWithTwoMembers();
  try {
    const ids = fourPosts(db);

    assert.equal(
      dao.safeRoomAdvanceId(db, '#r', 'me', undefined, ids),
      ids[3],
      'no since_id means no gap',
    );
    assert.equal(
      dao.safeRoomAdvanceId(db, '#r', 'me', 0, ids),
      ids[3],
      'a since_id at or below the watermark leaves no gap either',
    );
  } finally {
    db.close();
  }
});

/** `roomUnreadCount` must carry the same floor, or a badge and a read disagree. */
test('🚨 the count honours since_id too, so the badge cannot disagree with the read', () => {
  const db = roomWithTwoMembers();
  try {
    const ids = fourPosts(db);

    assert.equal(
      dao.roomUnreadCount(db, '#r', 'me', ids[1]),
      dao.roomUnread(db, '#r', 'me', 50, ids[1]).length,
    );
    assert.equal(dao.roomUnreadCount(db, '#r', 'me', ids[1]), 2);
  } finally {
    db.close();
  }
});

/** `allRoomsUnread` is the no-room `room_inbox` path and must pass it through. */
test('🚨 the all-rooms read honours since_id', () => {
  const db = roomWithTwoMembers();
  try {
    const ids = fourPosts(db);

    assert.deepEqual(
      dao.allRoomsUnread(db, 'me', 50, ids[1]).map((m) => m.body),
      ['c', 'd'],
    );
  } finally {
    db.close();
  }
});
