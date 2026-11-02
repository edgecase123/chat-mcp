import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { migrate } from '../../src/storage/db.js';
import * as dao from '../../src/storage/dao.js';

/**
 * 🛑 THE WHOLE POINT OF `unread` IS TO LET A WOKEN AGENT CALL NOTHING.
 *
 * The notify file already carries the body. What it could not say was whether
 * anything else was waiting, and the file is OVERWRITTEN on each write — so an
 * agent had to call an inbox to find out, every single wake, forever.
 *
 * `unread === 1` means this payload is everything. Above 1, read.
 */

function bus(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  for (const h of ['me', 'other']) {
    dao.upsertAgent(db, { handle: h, pid: 1, session_id: h, display_name: h, metadata: {} });
  }

  return db;
}

test('🚨 one waiting DM counts as 1, so the agent can skip the inbox', () => {
  const db = bus();

  try {
    dao.insertMessage(db, { from: 'other', to: 'me', body: 'hello' });

    assert.equal(dao.totalUnreadFor(db, 'me'), 1);
  } finally {
    db.close();
  }
});

test('🚨 two waiting DMs count as 2, which is what forces the read', () => {
  const db = bus();

  try {
    dao.insertMessage(db, { from: 'other', to: 'me', body: 'first' });
    dao.insertMessage(db, { from: 'other', to: 'me', body: 'second' });

    assert.equal(dao.totalUnreadFor(db, 'me'), 2);
  } finally {
    db.close();
  }
});

/**
 * 🛑 THE COUNT AND `pendingInbox` MUST AGREE. The fixture joins no rooms, so
 * the total IS the DM count here. The count goes in the payload and
 * the agent decides from it, so a count that includes what the read excludes
 * sends the agent after a message that is not there.
 */
test('🚨 the DM count equals what pendingInbox returns', () => {
  const db = bus();

  try {
    for (const body of ['a', 'b', 'c']) dao.insertMessage(db, { from: 'other', to: 'me', body });
    const first = dao.pendingInbox(db, { to: 'me' });
    dao.markRead(db, [first[0]!.id]);

    assert.equal(dao.totalUnreadFor(db, 'me'), dao.pendingInbox(db, { to: 'me' }).length);
    assert.equal(dao.totalUnreadFor(db, 'me'), 2);
  } finally {
    db.close();
  }
});

test('🚨 a read DM stops counting, so the number can reach the skip case again', () => {
  const db = bus();

  try {
    dao.insertMessage(db, { from: 'other', to: 'me', body: 'old' });
    dao.markRead(db, dao.pendingInbox(db, { to: 'me' }).map((m) => m.id));
    dao.insertMessage(db, { from: 'other', to: 'me', body: 'new' });

    assert.equal(dao.totalUnreadFor(db, 'me'), 1);
  } finally {
    db.close();
  }
});

/** A room message with no DMs waiting reaches the skip case on its own. */
test('🚨 one waiting room message counts as 1', () => {
  const db = bus();

  try {
    for (const h of ['me', 'other']) dao.joinRoom(db, '#r', h);
    const newest = db
      .prepare("SELECT COALESCE(MAX(id), 0) AS n FROM messages WHERE to_handle = '#r'")
      .get() as unknown as { n: number };
    for (const h of ['me', 'other']) dao.advanceRoomRead(db, '#r', h, Number(newest.n));

    dao.insertMessage(db, { from: 'other', to: '#r', body: 'room msg' });

    assert.equal(dao.totalUnreadFor(db, 'me'), 1);
  } finally {
    db.close();
  }
});

/**
 * 🛑 ONE NOTIFY FILE PER HANDLE, SO ONE COUNT ACROSS EVERY CHANNEL.
 *
 * A per-channel count is WORSE than no count. A room send that reports
 * `unread=1` while a DM also waits licenses the agent to skip the read, and
 * the DM is lost — the notify file was overwritten by this very message.
 *
 * Found by claude1 reviewing 2ca8b10, reproduced at runtime before fixing.
 */
test('🚨 unread spans DMs AND rooms, because one file carries both', () => {
  const db = bus();

  try {
    for (const h of ['me', 'other']) dao.joinRoom(db, '#r', h);
    const newest = db
      .prepare("SELECT COALESCE(MAX(id), 0) AS n FROM messages WHERE to_handle = '#r'")
      .get() as unknown as { n: number };
    for (const h of ['me', 'other']) dao.advanceRoomRead(db, '#r', h, Number(newest.n));

    dao.insertMessage(db, { from: 'other', to: 'me', body: 'a DM waits' });
    dao.insertMessage(db, { from: 'other', to: '#r', body: 'a room message waits' });

    // Two are waiting, so the agent MUST read whichever send wrote the file.
    assert.equal(dao.totalUnreadFor(db, 'me'), 2);
  } finally {
    db.close();
  }
});

test('🚨 a second room adds to the same total', () => {
  const db = bus();

  try {
    for (const room of ['#r', '#s']) {
      for (const h of ['me', 'other']) dao.joinRoom(db, room, h);
      const newest = db
        .prepare('SELECT COALESCE(MAX(id), 0) AS n FROM messages WHERE to_handle = ?')
        .get(room) as unknown as { n: number };
      for (const h of ['me', 'other']) dao.advanceRoomRead(db, room, h, Number(newest.n));
    }

    dao.insertMessage(db, { from: 'other', to: '#r', body: 'one' });
    dao.insertMessage(db, { from: 'other', to: '#s', body: 'two' });

    assert.equal(dao.totalUnreadFor(db, 'me'), 2);
  } finally {
    db.close();
  }
});

/** A room the handle is not in must not contribute. */
test('🚨 a room I am not a member of is not counted', () => {
  const db = bus();

  try {
    dao.joinRoom(db, '#theirs', 'other');
    dao.insertMessage(db, { from: 'other', to: '#theirs', body: 'not mine' });

    assert.equal(dao.totalUnreadFor(db, 'me'), 0);
  } finally {
    db.close();
  }
});

/**
 * 🛑 A GUARD, NOT A GREP-AFTER. Every live send path must carry `unread`, and
 * a new one added later must fail this rather than silently cost a read.
 *
 * Scoped to the paths an AGENT is woken by. The CLI and one-shot senders are
 * deliberately excluded — `unread` is documented as absent-means-unknown.
 */
test('🚨 every live send path passes unread to notifyPeer', () => {
  const live = [
    'src/shim/tools/send.ts',
    'src/shim/tools/room_send.ts',
    'src/cli/web/server.ts',
  ];

  for (const file of live) {
    const src = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
    const calls = src.split('notifyPeer(').slice(1);
    assert.ok(calls.length > 0, `${file} still calls notifyPeer, so the guard is not vacuous`);

    for (const [i, call] of calls.entries()) {
      const args = call.slice(0, call.indexOf(';'));
      // Only the paths carrying a message body owe a count. A bodyless ping
      // correctly tells the agent to go and read.
      if (!/body/.test(args)) continue;
      assert.match(args, /unread/, `${file} notifyPeer call ${i + 1} carries a body but no unread`);
    }
  }
});
