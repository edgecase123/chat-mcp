import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../../src/storage/db.js';
import * as dao from '../../src/storage/dao.js';

/**
 * 🛑 A REFUSAL WITHOUT ITS ALLOWLIST CANNOT SAY WHAT A GRANT WOULD HAVE DONE.
 *
 * claude1 on PR 43: the refused records carry no allowlist, so the test fake
 * answers `refused` even when a correct grant is present — the mirror of the
 * defect guarded on the permit side. 14 of 15 captures could never show a
 * grant working, and the N-of-N test had to use an empty allowlist, which is
 * fictional: every real refusal happened under a NON-empty one.
 *
 * So the row records what was in force when the child was refused.
 */

function freshDb() {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  return db;
}

test('an approval records the allowlist that was in force when the child was refused', () => {
  const db = freshDb();
  const allowlist = ['Read', 'Glob', 'Bash(git status:*)'];

  const id = dao.insertApproval(db, {
    agentHandle: 'a-agent',
    supervisorHandle: 'a',
    requested: "rm in '/tmp/x'",
    grant: 'Bash(rm /tmp/x)',
    reason: 'denied',
    allowlist,
  });

  assert.deepEqual(dao.getApproval(db, id)?.allowlist, allowlist);
});

/**
 * ⚠️ AN OLD ROW MUST READ BACK AS UNKNOWN, NOT AS EMPTY. Every approval filed
 * before this column existed had a non-empty allowlist that nobody recorded.
 * Reading those as `[]` would assert the child had nothing granted, which is
 * false, and would make a stale row look like a clean experiment.
 */
test('a row written before the column existed reads back as null, never as empty', () => {
  const db = freshDb();

  const id = dao.insertApproval(db, {
    agentHandle: 'a-agent',
    supervisorHandle: 'a',
    requested: null,
    grant: 'mcp__chat__set_status',
    reason: 'denied',
  });

  assert.equal(dao.getApproval(db, id)?.allowlist, null);
});

test('the migration adds the column to a database that already has approvals', () => {
  const db = freshDb();
  const cols = db
    .prepare(`SELECT name FROM pragma_table_info('approvals')`)
    .all()
    .map((r) => (r as { name: string }).name);

  assert.ok(cols.includes('allowlist'), `approvals has no allowlist column: ${cols.join(', ')}`);
});
