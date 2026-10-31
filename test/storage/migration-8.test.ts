import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { migrate } from '../../src/storage/db.js';
import * as dao from '../../src/storage/dao.js';

/**
 * 🚨 THE BUG THE WHOLE SUITE COULD NOT SEE.
 *
 * `requested` was made nullable by EDITING migration 7. `MIGRATIONS.length`
 * stayed at 7, so `for (i = current; i < length)` ran zero times on an
 * existing database and the old `NOT NULL` table survived. Measured live: an
 * unnameable denial hit the constraint, threw, and logged "nobody will be
 * asked" — the silence the change exists to remove.
 *
 * Every other test opens `:memory:` and migrates from zero, so every other
 * test saw the edited version and passed. Found by claude1 and by a live run
 * at the same time.
 */

/** A database at the version that shipped, with a row already in it. */
function existingDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  migrate(db);

  dao.insertApproval(db, {
    agentHandle: 'claude2-agent',
    supervisorHandle: 'claude2',
    requested: "rm in '/tmp/old.txt'",
    grant: 'Bash(rm -f /tmp/old.txt)',
    reason: 'historic row',
    sessionId: 'old',
  });

  return db;
}

test('an UNNAMED request can be stored, which is what the constraint blocked', () => {
  const db = existingDb();

  assert.doesNotThrow(() =>
    dao.insertApproval(db, {
      agentHandle: 'claude2-agent',
      supervisorHandle: 'claude2',
      requested: null,
      grant: null,
      reason: 'a git-push refusal names no command',
      sessionId: null,
    }),
  );
});

test('rows written before the rebuild survive it', () => {
  const db = existingDb();
  const historic = dao.pendingApprovals(db).find((a) => a.reason === 'historic row');

  assert.ok(historic, 'the rebuild dropped existing rows');
  assert.equal(historic?.requested, "rm in '/tmp/old.txt'");
});

test('the rebuilt table still refuses two answers', () => {
  const db = existingDb();
  const id = dao.pendingApprovals(db)[0]!.id;

  assert.equal(dao.answerApproval(db, id, 'deny'), true);
  assert.equal(dao.answerApproval(db, id, 'approve'), false, 'the index or guard was lost');
});

/**
 * 🛑 MIGRATION 7 MUST STAY AS IT SHIPPED. If it were also edited, a fresh
 * database would arrive nullable and never run migration 8 — so the rebuild
 * would execute nowhere except an already-migrated machine, which is the one
 * place nothing tests. Raised by claude1.
 */
test('migration 7 still creates the column NOT NULL, so migration 8 is exercised', () => {
  const src = readFileSync(new URL('../../src/storage/db.ts', import.meta.url), 'utf8');
  const create = src.slice(src.indexOf('CREATE TABLE approvals ('), src.indexOf('approvals_new'));

  assert.match(
    create,
    /requested\s+TEXT NOT NULL/,
    'migration 7 was edited, so a fresh DB never runs migration 8',
  );
});

test('the final schema is nullable, whichever path got there', () => {
  const db = existingDb();
  const sql = (
    db.prepare("SELECT sql FROM sqlite_master WHERE name='approvals'").get() as { sql: string }
  ).sql;

  assert.ok(!/requested\s+TEXT NOT NULL/.test(sql), `still NOT NULL:\n${sql}`);
});
