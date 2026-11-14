import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * 🛑 SET BEFORE THE IMPORTS BELOW. `notifyPeer` resolves `stateDir()`
 * transitively, so a static import would write into the operator's live
 * `~/.chat-mcp`.
 */
process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), 'chat-mcp-onlinecount-'));

const { DatabaseSync } = await import('node:sqlite');
const { migrate } = await import('../../src/storage/db.js');
const dao = await import('../../src/storage/dao.js');
const { sendToRoom } = await import('../../src/messaging/room-send.js');

/**
 * 🛑 `notified` ANSWERED THE WRONG QUESTION, AND IT WAS NOT WRONG.
 *
 * It counts the members this call wrote a notify file for, which really is
 * every member — an offline one reads the message on its next `room_inbox`.
 * The caller wanted a different number: how many are there to read it NOW.
 * Reading `notified: 4` as four readers is how a review request went to a dead
 * agent and was reported as handed off. #229.
 *
 * 🛑 lee RULED TWICE THAT `notified` IS LEFT ALONE and a NEW field carries the
 * live count, the second time after claude1 contradicted it. Re-meaning
 * `notified` would make it UNDER-REPORT work the code did.
 * #229 comment 6881867058.
 *
 * ⚠️ THE OTHER ROOM-SEND FIXTURE REGISTERS `pid: 1`, WHICH IS LIVE ON macOS —
 * `process.kill(1, 0)` throws EPERM and `isProcessAlive` reads that as alive.
 * So that fixture cannot produce an offline member at all, which is why this
 * file has its own.
 */

/** A pid that is certainly not running. 2^22 is above every default pid_max. */
const DEAD_PID = 4194303;

/** `null`, which is what a dead child's row holds after PR 235's clear. */
type Liveness = 'live' | 'dead' | 'cleared';

function pidFor(l: Liveness): number | null {
  if (l === 'live') return process.pid;
  if (l === 'dead') return DEAD_PID;

  return null;
}

function roomWith(members: ReadonlyArray<readonly [string, Liveness]>) {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  for (const [handle, liveness] of members) {
    dao.upsertAgent(db, {
      handle,
      pid: pidFor(liveness),
      session_id: handle,
      display_name: handle,
      metadata: {},
    });
    dao.joinRoom(db, '#gate', handle);
    assert.equal(
      dao.getAgent(db, handle)?.online,
      liveness === 'live',
      `fixture ${handle} must be ${liveness}`,
    );
  }

  return db;
}

const send = (db: InstanceType<typeof DatabaseSync>, from: string) =>
  sendToRoom(db, { room: '#gate', from, body: 'hi', advanceOwnRead: true });

test('the online count excludes members whose row is not live', () => {
  const db = roomWith([['gate', 'live'], ['claude1', 'live'], ['claude2', 'dead']]);

  const r = send(db, 'gate');

  assert.equal(r.onlineMembers, 1, 'only claude1 is live and not the sender');
  db.close();
});

/**
 * 🛑 THE RULING, PINNED. `notified` must keep counting every member this call
 * wrote to, offline ones included. A change here is a change lee reversed.
 */
test('`notified` still counts EVERY member, offline ones included', () => {
  const db = roomWith([['gate', 'live'], ['claude1', 'live'], ['claude2', 'dead']]);

  const r = send(db, 'gate');

  assert.equal(r.notified, 2, 'both non-senders were notified, live or not');
  db.close();
});

/** The headline #229 case: work was done, nobody was there to read it. */
test('🚨 every other member dead reports notified above zero and online zero', () => {
  const db = roomWith([['gate', 'live'], ['claude1', 'dead'], ['claude2', 'dead']]);

  const r = send(db, 'gate');

  assert.equal(r.notified, 2);
  assert.equal(r.onlineMembers, 0);
  db.close();
});

/** A row cleared by PR 235's child-exit path holds a NULL pid, not a dead one. */
test('a member whose pid was CLEARED on child exit is not counted online', () => {
  const db = roomWith([['gate', 'live'], ['claude1', 'cleared']]);

  const r = send(db, 'gate');

  assert.equal(r.notified, 1);
  assert.equal(r.onlineMembers, 0);
  db.close();
});

/**
 * 🛑 THE CONTROL ON THE SENDER. Counting the sender would make a live solo
 * sender report 1, which reads as "someone is there" when nobody is.
 */
test('the sender is excluded from the online count even though it is live', () => {
  const db = roomWith([['gate', 'live']]);

  const r = send(db, 'gate');

  assert.equal(r.notified, 0, 'nobody but the sender');
  assert.equal(r.onlineMembers, 0, 'the sender must not count itself');
  db.close();
});

/** The positive control: all live, so the two figures agree. */
test('with every member live the two counts agree', () => {
  const db = roomWith([['gate', 'live'], ['claude1', 'live'], ['claude2', 'live']]);

  const r = send(db, 'gate');

  assert.equal(r.notified, 2);
  assert.equal(r.onlineMembers, 2);
  db.close();
});
