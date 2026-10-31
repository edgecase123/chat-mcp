import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { migrate } from '../../src/storage/db.js';
import * as dao from '../../src/storage/dao.js';
import { answerAndNotify } from '../../src/supervise/answer.js';

/**
 * 🛑 ANSWERING A ROW IS HALF THE JOB. The other half is waking the
 * supervisor, and a first cut of the web handler woke the WEB USER's own
 * handle — nobody who could act on the answer.
 *
 * This existed only inside the HTTP handler, so nothing but a browser could
 * answer an approval. A capture harness needs the same sequence, and copying
 * it would be the second place the decision and the wake could drift apart.
 */

const notifyPath = (handle: string) => join(homedir(), '.chat-mcp', 'notify', handle);

function seed(db: DatabaseSync, supervisor: string) {
  return dao.insertApproval(db, {
    agentHandle: `${supervisor}-agent`,
    supervisorHandle: supervisor,
    requested: null,
    grant: 'mcp__chat__set_status',
    reason: 'denied',
    allowlist: ['Read'],
  });
}

test('answering wakes the SUPERVISOR with the decision in the envelope', () => {
  const db = new DatabaseSync(':memory:');
  migrate(db);

  const supervisor = `ans-${process.pid}`;
  const id = seed(db, supervisor);

  try {
    const outcome = answerAndNotify(db, id, 'approve', 'a-human');

    assert.equal(outcome.kind, 'answered');

    // 🛑 THE SUPERVISOR'S FILE, not the answerer's. That is the bug this
    // sequence already paid for once.
    const payload = JSON.parse(readFileSync(notifyPath(supervisor), 'utf8'));

    assert.equal(payload.to, supervisor);
    assert.equal(payload.approval.approvalId, id);
    assert.equal(payload.approval.decision, 'approve');
    assert.equal(payload.approval.grant, 'mcp__chat__set_status');
  } finally {
    rmSync(notifyPath(supervisor), { force: true });
  }
});

test('a second answer is reported as already answered, never as success', () => {
  const db = new DatabaseSync(':memory:');
  migrate(db);

  const supervisor = `ans2-${process.pid}`;
  const id = seed(db, supervisor);

  try {
    answerAndNotify(db, id, 'approve', 'a-human');

    const again = answerAndNotify(db, id, 'deny', 'a-human');

    assert.equal(again.kind, 'already-answered');
    assert.equal(again.kind === 'already-answered' ? again.decision : null, 'approve');
  } finally {
    rmSync(notifyPath(supervisor), { force: true });
  }
});

test('an approval with no grant cannot be approved, and says so', () => {
  const db = new DatabaseSync(':memory:');
  migrate(db);

  const supervisor = `ans3-${process.pid}`;
  const id = dao.insertApproval(db, {
    agentHandle: `${supervisor}-agent`,
    supervisorHandle: supervisor,
    requested: 'something in prose',
    reason: 'denied',
  });

  assert.equal(answerAndNotify(db, id, 'approve', 'a-human').kind, 'ungrantable');
  assert.equal(answerAndNotify(db, id, 'deny', 'a-human').kind, 'answered');

  rmSync(notifyPath(supervisor), { force: true });
});

test('an unknown id is reported as missing, not as ungrantable', () => {
  const db = new DatabaseSync(':memory:');
  migrate(db);

  assert.equal(answerAndNotify(db, 9999, 'approve', 'a-human').kind, 'no-such-approval');
});
