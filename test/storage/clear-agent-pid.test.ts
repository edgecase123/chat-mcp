import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import * as dao from '../../src/storage/dao.js';
import { migrate } from '../../src/storage/db.js';

/**
 * 🛑 `online` READ THE SUPERVISOR, NOT THE CHILD, FOR EVERY CONTAINERIZED AGENT.
 *
 * The row is written by `shimContextFor` running inside the host bus, so
 * `row.pid` is the supervisor's. An exited dockerized child therefore read
 * `online: true` until its supervisor died, and a sibling handed it a review.
 *
 * Nulling the pid is the whole repair: `isProcessAlive(null)` is already
 * `false`, so no consumer of `online` changes. These tests pin the two halves
 * that make that safe — the row SURVIVES, and a restart still reclaims it.
 */

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  migrate(db);

  return db;
}

function register(db: DatabaseSync, handle: string, pid: number) {
  return dao.upsertAgent(db, {
    handle,
    pid,
    session_id: `s-${pid}`,
    display_name: handle,
    metadata: { kind: 'agent' },
  });
}

test('clearing the pid turns a live-reading row offline', () => {
  const db = freshDb();
  register(db, 'claude2-agent', process.pid);
  assert.equal(dao.getAgent(db, 'claude2-agent')?.online, true);

  dao.clearAgentPid(db, 'claude2-agent');

  assert.equal(dao.getAgent(db, 'claude2-agent')?.online, false);
});

test('the positive control: an untouched row stays online', () => {
  const db = freshDb();
  register(db, 'claude2-agent', process.pid);
  register(db, 'claude1-agent', process.pid);

  dao.clearAgentPid(db, 'claude2-agent');

  assert.equal(dao.getAgent(db, 'claude1-agent')?.online, true);
});

test('the row SURVIVES, so the handle is still listed as offline', () => {
  const db = freshDb();
  register(db, 'claude2-agent', process.pid);

  dao.clearAgentPid(db, 'claude2-agent');

  const row = dao.getAgent(db, 'claude2-agent');
  assert.ok(row, 'clearing the pid must not delete the row');
  assert.equal(row.display_name, 'claude2-agent');
  assert.equal(row.session_id, `s-${process.pid}`);
  assert.equal(row.pid, null);

  const listed = dao.listAgents(db, true).map((a) => a.handle);
  assert.deepEqual(listed, ['claude2-agent']);
});

test('a cleared handle is absent from the default online-only listing', () => {
  const db = freshDb();
  register(db, 'claude2-agent', process.pid);

  dao.clearAgentPid(db, 'claude2-agent');

  assert.deepEqual(dao.listAgents(db), []);
});

test('a restart reclaims a cleared handle WITHOUT force', () => {
  const db = freshDb();
  register(db, 'claude2-agent', process.pid);
  dao.clearAgentPid(db, 'claude2-agent');

  // No `force`. This is the path a restarted child's own shim takes.
  const again = register(db, 'claude2-agent', process.pid);

  assert.equal(again.online, true);
  assert.equal(again.pid, process.pid);
});

test('clearing the pid does NOT move last_seen_at', () => {
  const db = freshDb();
  register(db, 'claude2-agent', process.pid);
  const before = dao.getAgent(db, 'claude2-agent')!.last_seen_at;

  dao.clearAgentPid(db, 'claude2-agent');

  assert.equal(dao.getAgent(db, 'claude2-agent')?.last_seen_at, before);
});

test('clearing an unknown handle reports it rather than throwing', () => {
  const db = freshDb();

  assert.equal(dao.clearAgentPid(db, 'nobody'), false);
});

test('clearing reports true when it changed a row', () => {
  const db = freshDb();
  register(db, 'claude2-agent', process.pid);

  assert.equal(dao.clearAgentPid(db, 'claude2-agent'), true);
});
