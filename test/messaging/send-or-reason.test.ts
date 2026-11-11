import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Point CHAT_MCP_HOME at a scratch dir BEFORE importing anything that reads it.
process.env.CHAT_MCP_HOME = join(mkdtempSync(join(tmpdir(), 'chat-mcp-reason-')), 'state');

const { migrate } = await import('../../src/storage/db.js');
const dao = await import('../../src/storage/dao.js');
const { sendOrReason } = await import('../../src/messaging/send-or-reason.js');
const { sendToRoom } = await import('../../src/messaging/room-send.js');

/**
 * #138 — the interactive surfaces must report a failed send instead of dying.
 *
 * 🛑 THE RETHROW IS THE LOAD-BEARING HALF. A helper that caught everything
 * would turn an unrelated SQLite failure back into the silence this ticket
 * exists to remove.
 */

function freshDb() {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  return db;
}

test('a send that lands comes back as its result', () => {
  const db = freshDb();

  const out = sendOrReason(() => dao.insertMessage(db, { from: 'a', to: 'b', body: 'lands' }));

  assert.ok('sent' in out);
  assert.equal(out.sent.id, dao.busHealth(db).max_id);
});

test('🛑 a send that does not persist comes back as a reason, not a throw', () => {
  const db = freshDb();
  db.exec('CREATE TRIGGER swallow BEFORE INSERT ON messages BEGIN SELECT RAISE(IGNORE); END');

  const out = sendOrReason(() => dao.insertMessage(db, { from: 'a', to: 'b', body: 'vanishes' }));

  assert.ok('reason' in out);
  assert.match(out.reason, /Nothing was sent from a to b/);
});

test('🛑 anything that is NOT a persistence failure still throws', () => {
  // The control. Without the `instanceof` check this helper would swallow
  // every error an interactive send can raise.
  const boom = new TypeError('unrelated');

  assert.throws(
    () =>
      sendOrReason(() => {
        throw boom;
      }),
    boom,
  );
});

test('🛑 a CALLER mistake on a room send still throws, so it is not reported as a drop', () => {
  // `NotARoomMemberError` is a 4xx-shaped input error. Turning it into a
  // "nothing was sent" reason would tell the operator the bus was broken when
  // they had simply not joined.
  const db = freshDb();

  assert.throws(
    () => sendOrReason(() => sendToRoom(db, { from: 'a', room: '#nope', body: 'x', advanceOwnRead: false })),
    { name: 'NotARoomMemberError' },
  );
});
