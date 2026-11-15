import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, renameSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point CHAT_MCP_HOME at a scratch dir BEFORE importing anything that reads it.
process.env.CHAT_MCP_HOME = join(
  mkdtempSync(join(tmpdir(), "chat-mcp-replaced-")),
  "state",
);

const { migrate, openDb } = await import("../../src/storage/db.js");
const { dbPath } = await import("../../src/util/paths.js");
const dao = await import("../../src/storage/dao.js");

/**
 * #138 — a send reported a real id into a file nobody else could read.
 *
 * 🛑 THE TWO EXISTING GUARDS BOTH PASS TRUTHFULLY WHEN THIS HAPPENS.
 * `openDb` opens the primary and the verifier back to back, so a file moved
 * aside afterwards is held by BOTH of them. The row writes to the orphaned
 * inode and reads back from it, so `changes === 1` and the witness is
 * satisfied. Measured on `2f3f4f3` before this guard existed: the send
 * returned id 1 and the file at the path held no rows.
 *
 * 🛑 THE FIXTURE REPLACES A REAL FILE. Nothing here stubs `statSync`. A mocked
 * stat proves the comparison is wired, not that a replaced database is what
 * trips it, and the whole defect is that every path-shaped instrument — `lsof`,
 * `PRAGMA database_list` — reports the path and cannot see this.
 */

/**
 * Move the whole database file SET aside and leave a fresh, migrated one at the
 * path.
 *
 * 🛑 THE `-wal` AND `-shm` MOVE TOO, AND LEAVING THEM COST A WRONG ANSWER. A
 * first probe moved only `chat.db`, so both files shared one WAL and the row
 * written through the old handle stayed readable at the new path — the defect
 * appeared not to exist.
 */
function replaceDatabaseFile(): DatabaseSync {
  const path = dbPath();

  for (const suffix of ["", "-wal", "-shm"]) {
    const p = `${path}${suffix}`;
    if (existsSync(p)) renameSync(p, `${p}.moved`);
  }

  const replacement = new DatabaseSync(path);
  replacement.exec("PRAGMA journal_mode = WAL");
  migrate(replacement);

  return replacement;
}

/**
 * Run `fn` and hand back what it threw.
 *
 * ⚠️ `assert.throws` RETURNS undefined, so a test that reads `.reason` off its
 * result reads it off nothing — and fails for a reason that has nothing to do
 * with the guard. That cost one round trip here.
 */
function thrown(fn: () => unknown): Error {
  try {
    fn();
  } catch (e) {
    return e as Error;
  }

  assert.fail("the send did not throw");
}

test("🚨 a send through a handle whose file was REPLACED throws instead of reporting an id", (t) => {
  const db = openDb();
  t.after(() => db.close());

  const replacement = replaceDatabaseFile();
  t.after(() => replacement.close());

  const err = thrown(() =>
    dao.insertMessage(db, {
      from: "claude2",
      to: "claude1",
      body: "does this reach anyone",
    }),
  );

  assert.ok(
    err instanceof dao.MessageNotPersistedError,
    `expected MessageNotPersistedError, got ${err.name}: ${err.message}`,
  );
  assert.equal(err.reason, "file-replaced");

  // ⚠️ THE CONSEQUENCE, NOT ONLY THE THROW. Without this the test passes on a
  // guard that throws for some unrelated reason, and the point of the ticket is
  // that the row becomes unreadable to everyone else.
  assert.deepEqual(
    replacement.prepare("SELECT id FROM messages").all(),
    [],
    "the file at the path holds the message after all, so this fixture is not the defect",
  );
});

/**
 * 🛑 THE SENTENCE HAS TO SAY RESTART. The other two reasons describe a write
 * that failed, and a retry can legitimately fix one of those. A replaced file
 * is a property of the CONNECTION, so every retry on this handle lands in the
 * same orphaned inode. Without the instruction the agent loops.
 */
test("🚨 the refusal tells the agent to RESTART, not to retry", (t) => {
  const db = openDb();
  t.after(() => db.close());

  const replacement = replaceDatabaseFile();
  t.after(() => replacement.close());

  const err = thrown(() =>
    dao.insertMessage(db, { from: "a", to: "b", body: "x" }),
  );

  assert.match(err.message, /RESTART/);
  assert.match(
    err.message,
    new RegExp(dbPath().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
});

/**
 * 🛑 THE NON-VACUITY CONTROL. Both tests above pass against a guard that
 * refuses EVERY send, and `openDb` is the only thing supplying the mark — so an
 * unreplaced file has to be shown to still work, through the same fixture
 * machinery.
 */
test("a send through an UNTOUCHED handle still returns its id", (t) => {
  const db = openDb();
  t.after(() => db.close());

  const { id } = dao.insertMessage(db, {
    from: "claude2",
    to: "claude1",
    body: "this one should land",
  });

  assert.ok(id > 0, `a healthy send returned id ${id}`);

  // ⚠️ `.get()` AND A FIELD READ, NOT `deepEqual` ON THE ROW. node:sqlite
  // returns null-prototype objects, so a structural compare against a literal
  // fails on the prototype while every value matches.
  const row = db
    .prepare("SELECT body FROM messages WHERE id = ?")
    .get(id) as unknown as { body: string } | undefined;

  assert.equal(row?.body, "this one should land");
});

/**
 * ⚠️ A DELETED FILE IS NOT A REPLACED ONE, AND `identityOf` ANSWERS null FOR IT
 * RATHER THAN THROWING. That null has to be treated as a mismatch, or the one
 * case where the state directory was wiped out from under a live agent is the
 * one case that still reports success.
 */
test("🚨 a send whose database file was DELETED is refused too", (t) => {
  const db = openDb();
  t.after(() => db.close());

  const path = dbPath();
  for (const suffix of ["", "-wal", "-shm"]) {
    const p = `${path}${suffix}`;
    if (existsSync(p)) renameSync(p, `${p}.gone`);
  }

  const err = thrown(() =>
    dao.insertMessage(db, { from: "a", to: "b", body: "x" }),
  );

  assert.ok(
    err instanceof dao.MessageNotPersistedError,
    `expected MessageNotPersistedError, got ${err.name}: ${err.message}`,
  );
  assert.equal(err.reason, "file-replaced");
});
