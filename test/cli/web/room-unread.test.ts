import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { migrate } from '../../../src/storage/db.js';
import * as dao from '../../../src/storage/dao.js';
import { route, type RouteContext } from '../../../src/cli/web/server.js';

/**
 * 🛑 A BADGE THAT NEVER CLEARS IS WORSE THAN NO BADGE. Reading a room is the
 * only thing that marks it read on the web path, and nothing did that before.
 * Each test here asserts the count both APPEARS and GOES AWAY.
 */

async function harness(handle = 'me'): Promise<{ db: DatabaseSync; server: Server; origin: string }> {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  for (const h of [handle, 'other']) {
    dao.upsertAgent(db, { handle: h, pid: 1, session_id: h, display_name: h, metadata: {} });
  }
  const ctx: RouteContext = { handle, db, sseClients: new Set() };
  const server = createServer((req, res) => { void route(req, res, ctx); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return { db, server, origin: `http://127.0.0.1:${port}` };
}

function close(h: { db: DatabaseSync; server: Server }): void {
  h.server.closeAllConnections();
  h.server.close();
  h.db.close();
}

async function roomsOf(origin: string): Promise<{ name: string; unread: number }[]> {
  const w = await (await fetch(`${origin}/api/whoami`)).json() as { rooms: { name: string; unread: number }[] };
  return w.rooms;
}

test('the count is a COUNT, not a page size', () => {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  dao.upsertAgent(db, { handle: 'me', pid: 1, session_id: 'me', display_name: 'me', metadata: {} });
  dao.joinRoom(db, '#ops', 'me');
  for (let i = 0; i < 120; i += 1) {
    dao.insertMessage(db, { from: 'other', to: '#ops', body: `m${i}` });
  }

  // roomUnread caps its rows; the count must not inherit that cap.
  assert.ok(dao.roomUnread(db, '#ops', 'me').length <= 50);
  // 120, not 121: joinRoom anchors the new member's watermark at its own
  // "joined" notice, so that line is already read when they arrive.
  assert.equal(dao.roomUnreadCount(db, '#ops', 'me'), 120);
  db.close();
});

test('whoami reports an unread count per room', async () => {
  const h = await harness();
  dao.joinRoom(h.db, '#ops', 'me');
  dao.insertMessage(h.db, { from: 'other', to: '#ops', body: 'hello' });

  const rooms = await roomsOf(h.origin);
  assert.equal(rooms.length, 1);
  assert.ok(rooms[0]!.unread >= 1, 'an unread message should be counted');
  close(h);
});

test('reading the room clears the count, so the badge goes away', async () => {
  const h = await harness();
  dao.joinRoom(h.db, '#ops', 'me');
  dao.insertMessage(h.db, { from: 'other', to: '#ops', body: 'hello' });
  assert.ok((await roomsOf(h.origin))[0]!.unread > 0);

  await fetch(`${h.origin}/api/messages?target=%23ops`);

  assert.equal((await roomsOf(h.origin))[0]!.unread, 0);
  close(h);
});

test('paging back through history cannot rewind the count', async () => {
  const h = await harness();
  dao.joinRoom(h.db, '#ops', 'me');
  const first = dao.insertMessage(h.db, { from: 'other', to: '#ops', body: 'one' });
  dao.insertMessage(h.db, { from: 'other', to: '#ops', body: 'two' });
  await fetch(`${h.origin}/api/messages?target=%23ops`);
  assert.equal((await roomsOf(h.origin))[0]!.unread, 0);

  // An older page whose newest id is BELOW the watermark.
  await fetch(`${h.origin}/api/messages?target=%23ops&before_id=${first.id}`);

  assert.equal((await roomsOf(h.origin))[0]!.unread, 0, 'the watermark rewound');
  close(h);
});

test('a new message after reading raises the count again', async () => {
  const h = await harness();
  dao.joinRoom(h.db, '#ops', 'me');
  await fetch(`${h.origin}/api/messages?target=%23ops`);
  assert.equal((await roomsOf(h.origin))[0]!.unread, 0);

  dao.insertMessage(h.db, { from: 'other', to: '#ops', body: 'later' });

  assert.equal((await roomsOf(h.origin))[0]!.unread, 1);
  close(h);
});
