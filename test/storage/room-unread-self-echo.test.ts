import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../../src/storage/db.js';
import * as dao from '../../src/storage/dao.js';

/**
 * 🛑 AN AGENT WAS PAYING TO RE-READ ITS OWN POSTS.
 *
 * `room_send` does not advance the sender's watermark, while the web UI and the
 * CLI both do. So an agent that posted and then read its room got its own
 * message back as "unread". Measured on #leagues on 2026-11-02: 7010 of 12403
 * bytes returned to claude2 were written by claude2.
 */

function roomWithTwoMembers(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  for (const h of ['me', 'other']) {
    dao.upsertAgent(db, { handle: h, pid: 1, session_id: h, display_name: h, metadata: {} });
    dao.joinRoom(db, '#r', h);
  }

  // 🛑 EACH join WRITES A SYSTEM MESSAGE, and the second one is unread to the
  // first joiner. Leaving it in made every count one too high, which read as a
  // failing filter rather than a dirty fixture.
  const newest = db
    .prepare("SELECT COALESCE(MAX(id), 0) AS n FROM messages WHERE to_handle = '#r'")
    .get() as unknown as { n: number };
  for (const h of ['me', 'other']) dao.advanceRoomRead(db, '#r', h, Number(newest.n));

  // The fixture starts from zero unread for everyone, asserted so a future
  // change to joinRoom cannot quietly reintroduce the skew.
  assert.equal(dao.roomUnreadCount(db, '#r', 'me'), 0, 'fixture starts clean for me');
  assert.equal(dao.roomUnreadCount(db, '#r', 'other'), 0, 'fixture starts clean for other');

  return db;
}

test('🚨 my own room post is not unread to me', () => {
  const db = roomWithTwoMembers();

  try {
    dao.insertMessage(db, { from: 'me', to: '#r', body: 'mine' });

    assert.deepEqual(dao.roomUnread(db, '#r', 'me'), []);
    assert.equal(dao.roomUnreadCount(db, '#r', 'me'), 0);
  } finally {
    db.close();
  }
});

/**
 * 🛑 THE NEGATIVE CONTROL, IN THE SAME TEST. A filter that drops everything
 * also passes the assertion above, so the sibling's message must still arrive.
 */
test('🚨 a sibling post IS still unread, so the filter is not dropping everything', () => {
  const db = roomWithTwoMembers();

  try {
    dao.insertMessage(db, { from: 'other', to: '#r', body: 'theirs' });

    const unread = dao.roomUnread(db, '#r', 'me');
    assert.equal(unread.length, 1);
    assert.equal(unread[0]?.body, 'theirs');
    assert.equal(dao.roomUnreadCount(db, '#r', 'me'), 1);
  } finally {
    db.close();
  }
});

test('🚨 interleaved, only the sibling messages come back', () => {
  const db = roomWithTwoMembers();

  try {
    dao.insertMessage(db, { from: 'other', to: '#r', body: 'a' });
    dao.insertMessage(db, { from: 'me', to: '#r', body: 'mine' });
    dao.insertMessage(db, { from: 'other', to: '#r', body: 'b' });

    assert.deepEqual(
      dao.roomUnread(db, '#r', 'me').map((m) => m.body),
      ['a', 'b'],
    );
    assert.equal(dao.roomUnreadCount(db, '#r', 'me'), 2);
  } finally {
    db.close();
  }
});

/**
 * ⚠️ THE COUNT AND THE PAGE MUST AGREE, because the badge comes from one and
 * the read from the other. An earlier shape filtered `roomUnread` only, so a
 * sidebar showed 3 and reading produced 2.
 */
test('🚨 the count matches what a read returns, so the badge cannot lie', () => {
  const db = roomWithTwoMembers();

  try {
    for (const body of ['a', 'b']) dao.insertMessage(db, { from: 'other', to: '#r', body });
    for (const body of ['x', 'y', 'z']) dao.insertMessage(db, { from: 'me', to: '#r', body });

    assert.equal(dao.roomUnreadCount(db, '#r', 'me'), dao.roomUnread(db, '#r', 'me').length);
    assert.equal(dao.roomUnreadCount(db, '#r', 'me'), 2);
  } finally {
    db.close();
  }
});

/** The sibling's own view is unaffected — this is per-reader, not a delete. */
test('🚨 the sibling still sees MY post as unread to them', () => {
  const db = roomWithTwoMembers();

  try {
    dao.insertMessage(db, { from: 'me', to: '#r', body: 'mine' });

    const theirs = dao.roomUnread(db, '#r', 'other');
    assert.equal(theirs.length, 1);
    assert.equal(theirs[0]?.body, 'mine');
  } finally {
    db.close();
  }
});

/**
 * `allRoomsUnread` is the `room_inbox` path with no room argument. It delegates
 * to `roomUnread`, so this pins that delegation rather than a second query.
 */
test('🚨 the all-rooms read excludes my own posts too', () => {
  const db = roomWithTwoMembers();

  try {
    dao.insertMessage(db, { from: 'me', to: '#r', body: 'mine' });
    dao.insertMessage(db, { from: 'other', to: '#r', body: 'theirs' });

    const all = dao.allRoomsUnread(db, 'me');
    const bodies = all.map((m) => m.body);

    assert.deepEqual(bodies, ['theirs']);
  } finally {
    db.close();
  }
});
