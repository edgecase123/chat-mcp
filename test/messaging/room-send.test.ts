import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * 🛑 SET BEFORE THE IMPORTS BELOW. `notifyPeer` resolves `stateDir()`
 * transitively via `ensureNotifyDir`, so a static import here would bind the
 * operator's live `~/.chat-mcp` and write real notify files.
 */
process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), 'chat-mcp-roomsend-'));

const { DatabaseSync } = await import('node:sqlite');
const { migrate } = await import('../../src/storage/db.js');
const dao = await import('../../src/storage/dao.js');
const { sendToRoom, NotARoomMemberError } = await import('../../src/messaging/room-send.js');

const NOTIFY = join(process.env.CHAT_MCP_HOME, 'notify');

function room(members: string[] = ['gate', 'claude1', 'claude2']) {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  for (const h of members) {
    dao.upsertAgent(db, { handle: h, pid: 1, session_id: h, display_name: h, metadata: {} });
    dao.joinRoom(db, '#gate', h);
  }
  const newest = db
    .prepare("SELECT COALESCE(MAX(id),0) AS n FROM messages WHERE to_handle = '#gate'")
    .get() as unknown as { n: number };
  for (const h of members) dao.advanceRoomRead(db, '#gate', h, Number(newest.n));
  return db;
}

/**
 * \u26a0\ufe0f EACH CASE OPENS A FRESH `:memory:` DB, SO MESSAGE IDS RESTART.
 * Two cases therefore both produce id 4, and a stale notify file from the
 * previous case is indistinguishable from this case's write. Clearing the
 * directory is what makes an absence assertion mean anything here.
 */
function clearNotify(): void {
  if (!existsSync(NOTIFY)) return;
  for (const f of readdirSync(NOTIFY)) rmSync(join(NOTIFY, f));
}

function payloadFor(handle: string): Record<string, unknown> | undefined {
  const p = join(NOTIFY, handle);
  if (!existsSync(p)) return undefined;
  return JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
}

test('the message lands in the room carrying its kind', () => {
  const db = room();
  try {
    const r = sendToRoom(db, {
      from: 'gate', room: '#gate', body: 'EXIT 1', kind: 'alert', advanceOwnRead: false,
    });

    const seen = dao.roomUnread(db, '#gate', 'claude2');
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.body, 'EXIT 1');
    assert.equal(seen[0]?.kind, 'alert');
    assert.equal(r.id, seen[0]?.id);
  } finally { db.close(); }
});

/**
 * 🛑 THE WHOLE POINT OF lee's `gate` HANDLE DECISION. Both agents must see the
 * verdict, and `roomUnread` excludes a reader's OWN posts by author.
 */
test('🚨 a ping sent as `gate` is visible to BOTH agents', () => {
  const db = room();
  try {
    sendToRoom(db, { from: 'gate', room: '#gate', body: 'EXIT 0', advanceOwnRead: false });

    assert.equal(dao.roomUnread(db, '#gate', 'claude1').length, 1, 'claude1 sees it');
    assert.equal(dao.roomUnread(db, '#gate', 'claude2').length, 1, 'claude2 sees it');
  } finally { db.close(); }
});

/**
 * ⚠️ THE NEGATIVE CONTROL for the test above. If the sender were a worktree
 * handle, that agent would see nothing — which is the design this replaced.
 */
test('🚨 control — sent as `claude2`, claude2 sees NOTHING and claude1 does', () => {
  const db = room();
  try {
    sendToRoom(db, { from: 'claude2', room: '#gate', body: 'EXIT 0', advanceOwnRead: false });

    assert.equal(dao.roomUnread(db, '#gate', 'claude2').length, 0, 'the runner is blind to it');
    assert.equal(dao.roomUnread(db, '#gate', 'claude1').length, 1, 'the sibling is not');
  } finally { db.close(); }
});

test('every member except the sender gets a notify payload, with unread', () => {
  const db = room();
  try {
    clearNotify();
    const r = sendToRoom(db, { from: 'gate', room: '#gate', body: 'EXIT 2', kind: 'alert', advanceOwnRead: false });

    for (const h of ['claude1', 'claude2']) {
      const p = payloadFor(h);
      assert.ok(p, `${h} was notified`);
      assert.equal(p?.to, '#gate');
      assert.equal(p?.from, 'gate');
      assert.equal(p?.kind, 'alert');
      assert.equal(p?.unread, 1, `${h} got an unread count`);
    }

    // \u26a0\ufe0f ID-SPECIFIC, NOT "no file". The notify dir is shared across the
    // cases in this file, and an earlier case legitimately notified `gate`.
    // Asserting absence here passed only while this case ran first.
    assert.equal(payloadFor('gate'), undefined, 'the sender is NOT notified');
    assert.ok(r.id > 0, 'control: the send did happen');
  } finally { db.close(); }
});

test('notified counts recipients, excluding the sender', () => {
  const db = room();
  try {
    const r = sendToRoom(db, { from: 'gate', room: '#gate', body: 'x', advanceOwnRead: false });
    assert.equal(r.notified, 2);
  } finally { db.close(); }
});

/**
 * 🛑 THE ONE BEHAVIOUR THE THREE CALLERS DISAGREED ON, so it is an explicit
 * argument with no default. `room_send` must not advance; the web UI and TUI do.
 */
test('🚨 advanceOwnRead: false leaves the sender watermark where it was', () => {
  const db = room();
  try {
    const before = dao.roomWatermark(db, '#gate', 'gate');
    const r = sendToRoom(db, { from: 'gate', room: '#gate', body: 'x', advanceOwnRead: false });

    assert.equal(dao.roomWatermark(db, '#gate', 'gate'), before);
    assert.notEqual(r.id, before, 'control: the id DID move, so the watermark could have');
  } finally { db.close(); }
});

test('🚨 advanceOwnRead: true moves the sender watermark to the new id', () => {
  const db = room();
  try {
    const r = sendToRoom(db, { from: 'claude2', room: '#gate', body: 'x', advanceOwnRead: true });

    assert.equal(dao.roomWatermark(db, '#gate', 'claude2'), r.id);
  } finally { db.close(); }
});

test('a non-member sender is refused with a typed error', () => {
  const db = room(['claude1', 'claude2']);
  try {
    dao.upsertAgent(db, { handle: 'gate', pid: 1, session_id: 'g', display_name: 'g', metadata: {} });

    assert.throws(
      () => sendToRoom(db, { from: 'gate', room: '#gate', body: 'x', advanceOwnRead: false }),
      (e: unknown) => e instanceof NotARoomMemberError,
    );
  } finally { db.close(); }
});

test('the refusal writes nothing — no message, no notify', () => {
  const db = room(['claude1', 'claude2']);
  try {
    const before = dao.roomUnread(db, '#gate', 'claude1').length;
    try {
      sendToRoom(db, { from: 'gate', room: '#gate', body: 'x', advanceOwnRead: false });
    } catch { /* asserted above */ }

    assert.equal(dao.roomUnread(db, '#gate', 'claude1').length, before);
  } finally { db.close(); }
});

test('a body over the 64 KB cap is refused', () => {
  const db = room();
  try {
    assert.throws(
      () => sendToRoom(db, {
        from: 'gate', room: '#gate', body: 'a'.repeat(64 * 1024 + 1), advanceOwnRead: false,
      }),
      /exceeds 65536-byte cap/,
    );
  } finally { db.close(); }
});

test('a body exactly at the cap is accepted, so the boundary is not off by one', () => {
  const db = room();
  try {
    const r = sendToRoom(db, {
      from: 'gate', room: '#gate', body: 'a'.repeat(64 * 1024), advanceOwnRead: false,
    });
    assert.ok(r.id > 0);
  } finally { db.close(); }
});

test('a malformed room name is refused', () => {
  const db = room();
  try {
    assert.throws(() => sendToRoom(db, {
      from: 'gate', room: 'gate', body: 'x', advanceOwnRead: false,
    }));
  } finally { db.close(); }
});
