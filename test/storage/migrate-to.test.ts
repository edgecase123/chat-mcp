import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  migrate,
  migrateTo,
  currentSchemaVersion,
  SCHEMA_VERSION,
} from "../../src/storage/db.js";

test("migrateTo stops at the version asked for", () => {
  const db = new DatabaseSync(":memory:");

  migrateTo(db, 7);

  assert.equal(currentSchemaVersion(db), 7);
});

test("a database at version 7 still has the NOT NULL migration 8 exists to remove", () => {
  const db = new DatabaseSync(":memory:");

  migrateTo(db, 7);

  const sql = (
    db.prepare("SELECT sql FROM sqlite_master WHERE name='approvals'").get() as
      { sql: string } | undefined
  )?.sql;

  assert.ok(sql, "no approvals table at version 7");
  assert.match(sql!, /requested\s+TEXT NOT NULL/);
});

test("migrate carries a partially migrated database the rest of the way", () => {
  const db = new DatabaseSync(":memory:");
  migrateTo(db, 7);

  migrate(db);

  assert.equal(currentSchemaVersion(db), SCHEMA_VERSION);
});

/**
 * 🛑 THE FAILURE THIS GUARD EXISTS FOR IS #172's OWN. A fixture that asks for
 * a version and silently receives the current one is exactly the vacuous
 * database `existingDb` used to build. claude1's finding on PR 284.
 */
test("migrateTo refuses a version that does not exist", () => {
  const db = new DatabaseSync(":memory:");

  assert.throws(() => migrateTo(db, SCHEMA_VERSION + 1), /SCHEMA_VERSION/);

  const { n } = db
    .prepare("SELECT count(*) AS n FROM sqlite_master")
    .get() as unknown as { n: number };
  assert.equal(n, 0, "a refused target still wrote to the database");
});

test("migrateTo refuses a target below the version already stored", () => {
  const db = new DatabaseSync(":memory:");
  migrateTo(db, 7);

  assert.throws(() => migrateTo(db, 3), /already at version 7/);
  assert.equal(currentSchemaVersion(db), 7);
});

test("migrateTo refuses a target that is not a version number", () => {
  const db = new DatabaseSync(":memory:");

  assert.throws(() => migrateTo(db, 0), /SCHEMA_VERSION/);
  assert.throws(() => migrateTo(db, -5), /SCHEMA_VERSION/);
  assert.throws(() => migrateTo(db, 1.5), /SCHEMA_VERSION/);
});

/** `migrate` runs on every open, so a current database must not throw. */
test("migrate is idempotent on an already current database", () => {
  const db = new DatabaseSync(":memory:");
  migrate(db);

  assert.doesNotThrow(() => migrate(db));
  assert.equal(currentSchemaVersion(db), SCHEMA_VERSION);
});
