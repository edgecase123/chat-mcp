import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../../src/storage/db.js';
import * as dao from '../../src/storage/dao.js';

/**
 * #163 — an answered approval recorded WHAT and WHEN, never WHO.
 *
 * 🛑 THE HANDLE ONLY. lee ruled on 2026-11-11 that the request context is not
 * recorded again, because `requested`, `reason`, `session_id` and
 * `answered_at` are already columns of this row.
 */

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  migrate(db);

  return db;
}

const REQUEST = {
  agentHandle: 'claude2-agent',
  supervisorHandle: 'claude2',
  requested: "rm in '/tmp/target.txt'",
  grant: 'Bash(rm -f /tmp/target.txt)',
  reason: 'denied',
};

test('an approved row records who approved it', () => {
  const db = freshDb();
  const id = dao.insertApproval(db, REQUEST);

  dao.answerApproval(db, id, 'approve', 'leejenkins');

  assert.equal(dao.getApproval(db, id)?.answeredBy, 'leejenkins');
});

/**
 * 🛑 BOTH DIRECTIONS. A denial is the answer an incident review cares about
 * most, and a fixture that only ever approves cannot tell the two apart.
 */
test('a denied row records who denied it', () => {
  const db = freshDb();
  const id = dao.insertApproval(db, REQUEST);

  dao.answerApproval(db, id, 'deny', 'claude1');

  const row = dao.getApproval(db, id);

  assert.equal(row?.decision, 'deny');
  assert.equal(row?.answeredBy, 'claude1');
});

/**
 * 🛑 NULL READS AS UNKNOWN, NEVER AS A HANDLE. Every row answered before this
 * column existed has one, and reading it as a name would attribute a decision
 * to whoever happened to sort first.
 */
test('a row answered before the column existed reads as unknown', () => {
  const db = freshDb();
  const id = dao.insertApproval(db, REQUEST);

  // The pre-#163 write, verbatim: the two columns that shipped without a third.
  db.prepare('UPDATE approvals SET answered_at = ?, decision = ? WHERE id = ?').run(
    Date.now(),
    'approve',
    id,
  );

  const row = dao.getApproval(db, id);

  assert.equal(row?.decision, 'approve');
  assert.equal(row?.answeredBy, null);
});

/**
 * 🛑 THE COMPARE-AND-SWAP COVERS THE NEW COLUMN TOO. Without this, a second
 * click would leave the first handle's decision in place and overwrite the
 * name beside it — the one combination that is worse than recording nothing.
 */
test('a second answer cannot overwrite the first approver', () => {
  const db = freshDb();
  const id = dao.insertApproval(db, REQUEST);

  assert.equal(dao.answerApproval(db, id, 'approve', 'leejenkins'), true);
  assert.equal(dao.answerApproval(db, id, 'deny', 'someone-else'), false);

  const row = dao.getApproval(db, id);

  assert.equal(row?.decision, 'approve');
  assert.equal(row?.answeredBy, 'leejenkins');
});
