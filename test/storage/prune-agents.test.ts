import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../../src/storage/db.js';
import * as dao from '../../src/storage/dao.js';

/**
 * 🛑 A PRUNE THAT MATCHES BY PREFIX CAN DELETE A REAL HANDLE. `perm-` looks
 * like a safe prefix right up to the first real peer that starts with it, and
 * deleting a live agent's row frees its handle for someone else to claim.
 */

function dbWith(...handles: string[]): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  for (const h of handles) {
    dao.upsertAgent(db, { handle: h, pid: 1, session_id: h, display_name: h, metadata: {} });
  }
  assert.equal(dao.listAgents(db, true).length, handles.length, 'fixture registered all');
  return db;
}

test('🚨 pruning deletes exactly the named handles', () => {
  const db = dbWith('perm-1-agent', 'perm-2-agent', 'claude1');

  const gone = dao.pruneAgents(db, ['perm-1-agent', 'perm-2-agent']);

  assert.deepEqual(gone, ['perm-1-agent', 'perm-2-agent']);
  assert.deepEqual(dao.listAgents(db, true).map((a) => a.handle), ['claude1']);
  db.close();
});

/** 🛑 THE WHOLE POINT. A prefix is not a match. */
test('🚨 a prefix matches nothing, so a real peer sharing it survives', () => {
  const db = dbWith('perm-1-agent', 'permanent-reviewer');

  const gone = dao.pruneAgents(db, ['perm-']);

  assert.deepEqual(gone, [], 'nothing deleted by a prefix');
  assert.equal(dao.listAgents(db, true).length, 2);
  db.close();
});

/**
 * ⚠️ IT REPORTS WHAT IT DELETED, NOT WHAT IT WAS ASKED FOR. Echoing the input
 * would make a typo look like a successful prune.
 */
test('🚨 a handle that does not exist is absent from the result', () => {
  const db = dbWith('perm-1-agent');

  const gone = dao.pruneAgents(db, ['perm-1-agent', 'typo-agent']);

  assert.deepEqual(gone, ['perm-1-agent']);
  db.close();
});

test('🚨 an empty list deletes nothing', () => {
  const db = dbWith('claude1', 'claude2');

  assert.deepEqual(dao.pruneAgents(db, []), []);
  assert.equal(dao.listAgents(db, true).length, 2);
  db.close();
});

/** Pruning clears room state too, or a reclaimed handle inherits watermarks. */
test('🚨 pruning clears room membership for the handles it deletes', () => {
  const db = dbWith('perm-1-agent', 'claude1');
  dao.joinRoom(db, '#r', 'perm-1-agent');
  dao.joinRoom(db, '#r', 'claude1');

  dao.pruneAgents(db, ['perm-1-agent']);

  assert.equal(dao.isRoomMember(db, '#r', 'perm-1-agent'), false);
  assert.equal(dao.isRoomMember(db, '#r', 'claude1'), true, 'the survivor keeps its room');
  db.close();
});

/**
 * 🛑 NOTHING IN CI RUNS A LIVE HARNESS, so only a source check can prove the
 * four of them opted in. A leak here is invisible until a human prunes by hand.
 */
test('🚨 every live harness passes ephemeral: true', () => {
  const harnesses = [
    'capture-permits.mjs',
    'capture-refusals.mjs',
    'supervise-e2e.mjs',
    'supervise-live.mjs',
  ];

  const missing = harnesses.filter((h) => {
    const src = readFileSync(new URL(`../../scripts/${h}`, import.meta.url), 'utf8');
    // Anchor on the call, so a rename of the script does not silently pass.
    assert.match(src, /startSupervisor\(\{/, `${h} no longer starts a supervisor`);
    return !src.includes('ephemeral: true');
  });

  assert.deepEqual(missing, [], `harnesses still leaking their agent: ${missing.join(', ')}`);
});

/**
 * 🛑 AN ONLINE HANDLE IS THE ONE THING PRUNING MUST NOT TOUCH. Freeing a live
 * agent's handle lets another process claim it, and then `inbox` marks messages
 * read for whichever of the two reads first.
 */
test('🚨 an online handle is held back, not pruned', () => {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  dao.upsertAgent(db, { handle: 'live', pid: process.pid, session_id: 'l', display_name: 'l', metadata: {} });
  dao.upsertAgent(db, { handle: 'dead', pid: 2, session_id: 'd', display_name: 'd', metadata: {} });

  const p = dao.partitionPrunable(db, ['live', 'dead', 'never-existed']);

  assert.deepEqual(p.online, ['live']);
  assert.deepEqual(p.prunable, ['dead']);
  assert.deepEqual(p.absent, ['never-existed']);
  db.close();
});

/** The negative control: with nothing live, everything registered is prunable. */
test('🚨 a fully dead set is entirely prunable', () => {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  for (const h of ['d1', 'd2']) {
    dao.upsertAgent(db, { handle: h, pid: 2, session_id: h, display_name: h, metadata: {} });
  }

  const p = dao.partitionPrunable(db, ['d1', 'd2']);

  assert.deepEqual(p.prunable, ['d1', 'd2']);
  assert.deepEqual(p.online, []);
  db.close();
});
