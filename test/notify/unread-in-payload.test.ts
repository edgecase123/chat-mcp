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

    assert.equal(dao.unreadFor(db, 'me', 'me'), 1);
  } finally {
    db.close();
  }
});

test('🚨 two waiting DMs count as 2, which is what forces the read', () => {
  const db = bus();

  try {
    dao.insertMessage(db, { from: 'other', to: 'me', body: 'first' });
    dao.insertMessage(db, { from: 'other', to: 'me', body: 'second' });

    assert.equal(dao.unreadFor(db, 'me', 'me'), 2);
  } finally {
    db.close();
  }
});

/**
 * 🛑 THE COUNT AND `pendingInbox` MUST AGREE. The count goes in the payload and
 * the agent decides from it, so a count that includes what the read excludes
 * sends the agent after a message that is not there.
 */
test('🚨 the DM count equals what pendingInbox returns', () => {
  const db = bus();

  try {
    for (const body of ['a', 'b', 'c']) dao.insertMessage(db, { from: 'other', to: 'me', body });
    const first = dao.pendingInbox(db, { to: 'me' });
    dao.markRead(db, [first[0]!.id]);

    assert.equal(dao.unreadFor(db, 'me', 'me'), dao.pendingInbox(db, { to: 'me' }).length);
    assert.equal(dao.unreadFor(db, 'me', 'me'), 2);
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

    assert.equal(dao.unreadFor(db, 'me', 'me'), 1);
  } finally {
    db.close();
  }
});

/** A `#` target routes to the room watermark, not to `read_at`. */
test('🚨 unreadFor routes a room target to the room count', () => {
  const db = bus();

  try {
    for (const h of ['me', 'other']) dao.joinRoom(db, '#r', h);
    const newest = db
      .prepare("SELECT COALESCE(MAX(id), 0) AS n FROM messages WHERE to_handle = '#r'")
      .get() as unknown as { n: number };
    for (const h of ['me', 'other']) dao.advanceRoomRead(db, '#r', h, Number(newest.n));

    dao.insertMessage(db, { from: 'other', to: '#r', body: 'room msg' });

    assert.equal(dao.unreadFor(db, 'me', '#r'), 1);
    // 🛑 The DM path must NOT see it. A room message is not a DM, and a
    // picker that fell through to `read_at` would count it here.
    assert.equal(dao.unreadFor(db, 'me', 'me'), 0);
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
