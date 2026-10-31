import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../../src/storage/db.js';
import * as dao from '../../src/storage/dao.js';

/**
 * 🛑 AN APPROVAL IS A MODAL WITH TWO OUTCOMES, NOT A SENTENCE.
 *
 * A supervised agent denied a command is told not to retry for the rest of the
 * session, so it stops partway through and nobody is told. The store here is
 * how the request reaches a human: the supervisor and the web server are
 * separate processes already sharing `~/.chat-mcp/chat.db`.
 */

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  migrate(db);

  return db;
}

const REQUEST = {
  agentHandle: 'claude2-agent',
  supervisorHandle: 'claude2',
  requested: 'rm -f /tmp/target.txt',
  reason: 'Permission for this tool use was denied. ... What required approval: rm',
  sessionId: 'abc-123',
};

test('a pending approval is readable after it is written', () => {
  const db = freshDb();
  const id = dao.insertApproval(db, REQUEST);

  const pending = dao.pendingApprovals(db);

  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.id, id);
});

/**
 * 🛑 VERBATIM, NEVER SUMMARISED. The operator is approving one specific
 * string, and that same string is what gets added to the allowlist. A
 * paraphrase means approving something the child never asked for.
 */
test('the command survives the round trip byte for byte', () => {
  const db = freshDb();
  dao.insertApproval(db, REQUEST);

  assert.equal(dao.pendingApprovals(db)[0]?.requested, 'rm -f /tmp/target.txt');
});

test('the full denial reason is kept, so the UI can quote it', () => {
  const db = freshDb();
  dao.insertApproval(db, REQUEST);

  assert.equal(dao.pendingApprovals(db)[0]?.reason, REQUEST.reason);
});

/**
 * The session id is what makes `--resume` possible. Without it the only
 * recovery is a fresh child that has forgotten the task.
 */
test('the session to resume is carried with the request', () => {
  const db = freshDb();
  dao.insertApproval(db, REQUEST);

  assert.equal(dao.pendingApprovals(db)[0]?.sessionId, 'abc-123');
});

test('an answered approval leaves the pending list', () => {
  const db = freshDb();
  const id = dao.insertApproval(db, REQUEST);

  assert.equal(dao.answerApproval(db, id, 'approve'), true);
  assert.deepEqual(dao.pendingApprovals(db), []);
});

test('the decision is readable after answering', () => {
  const db = freshDb();
  const id = dao.insertApproval(db, REQUEST);
  dao.answerApproval(db, id, 'deny');

  assert.equal(dao.getApproval(db, id)?.decision, 'deny');
});

/**
 * 🛑 TWO BROWSER TABS ARE THE NORMAL CASE, so the second click must be
 * REFUSED rather than silently granting again. This is the same
 * compare-and-swap the handle claim needed: check-then-write is not atomic,
 * and a second grant for an already-denied request is the worst outcome.
 */
test('an approval cannot be answered twice', () => {
  const db = freshDb();
  const id = dao.insertApproval(db, REQUEST);

  assert.equal(dao.answerApproval(db, id, 'deny'), true);
  assert.equal(dao.answerApproval(db, id, 'approve'), false, 'the second answer was accepted');
});

test('a second answer does not overwrite the first decision', () => {
  const db = freshDb();
  const id = dao.insertApproval(db, REQUEST);

  dao.answerApproval(db, id, 'deny');
  dao.answerApproval(db, id, 'approve');

  assert.equal(dao.getApproval(db, id)?.decision, 'deny', 'a deny was upgraded to an approve');
});

test('answering an id that does not exist returns false rather than throwing', () => {
  const db = freshDb();

  assert.equal(dao.answerApproval(db, 999, 'approve'), false);
});

/**
 * ⚠️ A supervisor waiting on a request the operator never sees is
 * indistinguishable from a hung agent. The store must at least make the age
 * visible so something above it can time out.
 */
test('a pending approval carries its age', () => {
  const db = freshDb();
  const before = Date.now();
  dao.insertApproval(db, REQUEST);

  const created = dao.pendingApprovals(db)[0]?.createdAt ?? 0;

  assert.ok(created >= before, 'createdAt predates the insert');
  assert.ok(created <= Date.now(), 'createdAt is in the future');
});

test('pending approvals come back oldest first, because that is the answer order', () => {
  const db = freshDb();
  const first = dao.insertApproval(db, { ...REQUEST, requested: 'one' });
  const second = dao.insertApproval(db, { ...REQUEST, requested: 'two' });

  const ids = dao.pendingApprovals(db).map((a) => a.id);

  assert.deepEqual(ids, [first, second]);
});

/**
 * 🛑 THE ANSWER HAS TO REACH A PROCESS THAT CAN ACT ON IT. A first cut woke
 * the web user's own handle, which wakes nobody. The request has to name its
 * supervisor.
 */
test('the request names the supervisor to wake, not just the child', () => {
  const db = freshDb();
  dao.insertApproval(db, REQUEST);

  assert.equal(dao.pendingApprovals(db)[0]?.supervisorHandle, 'claude2');
  assert.notEqual(
    dao.pendingApprovals(db)[0]?.supervisorHandle,
    dao.pendingApprovals(db)[0]?.agentHandle,
    'the supervisor and its child must be distinguishable',
  );
});

test('approvals are scoped per agent, so two supervisors do not see each other', () => {
  const db = freshDb();
  dao.insertApproval(db, { ...REQUEST, agentHandle: 'claude1-agent' });
  dao.insertApproval(db, { ...REQUEST, agentHandle: 'claude2-agent' });

  assert.equal(dao.pendingApprovals(db, 'claude2-agent').length, 1);
  assert.equal(dao.pendingApprovals(db).length, 2, 'omitting the handle must return all');
});

/**
 * 🚨 AN UNNAMED REQUEST CAN BE DENIED, NEVER APPROVED.
 *
 * Measured end to end 2026-10-31: a `git push` denial gives a prose reason
 * with no command. A placeholder was filed, lee APPROVED A BLANK, the
 * literal went into `--allowedTools` and granted nothing, the retry was
 * denied, and a second card appeared.
 *
 * ⚠️ FILING NOTHING WAS THE FIRST FIX AND IT WAS WORSE — claude1: it
 * restores the bug #39 exists to fix, because the child stops and nobody is
 * told. The row is filed; only Approve is refused.
 */
test('an unnamed request is stored as NULL, not as a placeholder', () => {
  const db = freshDb();
  dao.insertApproval(db, { ...REQUEST, requested: null });

  assert.equal(dao.pendingApprovals(db)[0]?.requested, null);
});

test('approving an unnamed request THROWS rather than granting a blank', () => {
  const db = freshDb();
  const id = dao.insertApproval(db, { ...REQUEST, requested: null });

  assert.throws(() => dao.answerApproval(db, id, 'approve'), dao.UnnameableApprovalError);
});

/** Stopping something you cannot name is always a safe answer. */
test('an unnamed request CAN be denied', () => {
  const db = freshDb();
  const id = dao.insertApproval(db, { ...REQUEST, requested: null });

  assert.equal(dao.answerApproval(db, id, 'deny'), true);
  assert.equal(dao.getApproval(db, id)?.decision, 'deny');
});

test('a refused approve leaves the request still pending, not half-answered', () => {
  const db = freshDb();
  const id = dao.insertApproval(db, { ...REQUEST, requested: null });

  assert.throws(() => dao.answerApproval(db, id, 'approve'));
  assert.equal(dao.pendingApprovals(db).length, 1, 'the refusal consumed the request');
});

/**
 * ⚠️ `?.requested == null` is ALSO true for a row that is not there, so the
 * first version of the guard threw "cannot be approved" for a missing id —
 * reporting "no such approval" as a different problem entirely.
 */
test('approving an id that does not exist still returns false, not a throw', () => {
  const db = freshDb();

  assert.equal(dao.answerApproval(db, 4242, 'approve'), false);
});
