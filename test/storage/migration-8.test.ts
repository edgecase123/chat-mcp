import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { migrate, migrateTo } from "../../src/storage/db.js";
import * as dao from "../../src/storage/dao.js";

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

/**
 * A database at version 7 carried forward by `migrate`, with a row already in
 * it.
 *
 * 🛑 IT USED TO CALL `migrate` ALONE, so "the version that shipped" was always
 * the CURRENT version and migration 8's rebuild ran on a table migration 8 had
 * already rebuilt. `migrateTo(db, 7)` is what makes the carry-forward real.
 */
function existingDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  migrateTo(db, 7);

  // 🛑 RAW SQL, NOT `dao.insertApproval`. The DAO is written against the
  // CURRENT schema and binds `grant_entry`, a column migration 7 does not
  // have — so seeding a historical database through it throws.
  db.prepare(
    `INSERT INTO approvals
       (agent_handle, supervisor_handle, requested, reason, session_id,
        created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    "claude2-agent",
    "claude2",
    "rm in '/tmp/old.txt'",
    "historic row",
    "old",
    Date.now(),
  );

  migrate(db);

  return db;
}

test("an UNNAMED request can be stored, which is what the constraint blocked", () => {
  const db = existingDb();

  assert.doesNotThrow(() =>
    dao.insertApproval(db, {
      agentHandle: "claude2-agent",
      supervisorHandle: "claude2",
      requested: null,
      grant: null,
      reason: "a git-push refusal names no command",
      sessionId: null,
    }),
  );
});

test("rows written before the rebuild survive it", () => {
  const db = existingDb();
  const historic = dao
    .pendingApprovals(db)
    .find((a) => a.reason === "historic row");

  assert.ok(historic, "the rebuild dropped existing rows");
  assert.equal(historic?.requested, "rm in '/tmp/old.txt'");
});

test("the rebuilt table still refuses two answers", () => {
  const db = existingDb();
  const id = dao.pendingApprovals(db)[0]!.id;

  // 🛑 DENY TWICE, NOT deny-then-approve. A row carried from version 7 has no
  // `grant_entry`, so the approve path throws before it ever reaches the
  // answered_at guard this test is about. The next test owns that throw.
  assert.equal(dao.answerApproval(db, id, "deny", "operator"), true);
  assert.equal(
    dao.answerApproval(db, id, "deny", "operator"),
    false,
    "the index or guard was lost",
  );
});

/**
 * The state a real migrated database is in, which the old fixture could not
 * reach: migration 7 had no `grant_entry` column, so every row that predates
 * it carries a null grant.
 */
test("a row carried up from version 7 can be denied but not approved", () => {
  const db = existingDb();
  const id = dao.pendingApprovals(db)[0]!.id;

  assert.equal(dao.getApproval(db, id)?.grant, null);
  assert.throws(() => dao.answerApproval(db, id, "approve", "operator"), {
    name: "UnnameableApprovalError",
  });
  assert.equal(dao.answerApproval(db, id, "deny", "operator"), true);
});

/**
 * 🛑 MIGRATION 7 MUST STAY AS IT SHIPPED. If it were also edited, a fresh
 * database would arrive nullable and never run migration 8 — so the rebuild
 * would execute nowhere except an already-migrated machine, which is the one
 * place nothing tests. Raised by claude1.
 */
test("migration 7 still creates the column NOT NULL, so migration 8 is exercised", () => {
  const src = readFileSync(
    new URL("../../src/storage/db.ts", import.meta.url),
    "utf8",
  );
  const create = src.slice(
    src.indexOf("CREATE TABLE approvals ("),
    src.indexOf("approvals_new"),
  );

  assert.match(
    create,
    /requested\s+TEXT NOT NULL/,
    "migration 7 was edited, so a fresh DB never runs migration 8",
  );
});

test("the final schema is nullable, whichever path got there", () => {
  const db = existingDb();
  const sql = (
    db
      .prepare("SELECT sql FROM sqlite_master WHERE name='approvals'")
      .get() as { sql: string }
  ).sql;

  assert.ok(!/requested\s+TEXT NOT NULL/.test(sql), `still NOT NULL:\n${sql}`);
});
