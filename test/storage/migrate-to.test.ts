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
