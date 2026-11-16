import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 🛑 BEFORE ANY IMPORT THAT RESOLVES A STATE PATH, or `openDb` opens the
// OPERATOR'S LIVE database.
process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), "cm-jtx-"));

const { openDb, verifierFor } = await import("../../src/storage/db.js");
const dao = await import("../../src/storage/dao.js");

/**
 * 🚨 THE GUARD AGAINST THE REJECTED #277 DESIGN, AND IT NEEDS A REAL
 * `openDb` CONNECTION.
 *
 * Wrapping `joinRoom`'s announce in the transaction too makes every join throw
 * `row-absent-on-reread`: `insertMessage` proves its row landed by re-reading
 * it on the SECOND connection `openDb` opens, and that connection cannot see
 * an uncommitted row.
 *
 * 🛑 A TEMP FILE IS NOT ENOUGH, AND THAT IS WHY THIS FILE EXISTS. A
 * `new DatabaseSync(<path>)` has no verifier registered, so `verifierFor`
 * returns undefined and the witness falls back to the writing connection — it
 * sees the uncommitted row and passes. The first version of this guard did
 * exactly that: the rejected design was installed as a mutant and all five
 * tests still passed.
 */
test("🚨 the database under test really has a SECOND connection, or this file proves nothing", () => {
  const db = openDb();

  try {
    assert.notEqual(
      verifierFor(db),
      undefined,
      "no verifier connection, so an uncommitted row would be visible to the witness and the rejected design would pass",
    );
  } finally {
    db.close();
  }
});

test("🚨 a join commits against a real second connection, so the announce is outside the transaction", () => {
  const db = openDb();

  try {
    dao.upsertAgent(db, {
      handle: "alice",
      pid: 1,
      session_id: "s",
      display_name: "alice",
      metadata: {},
    });

    const result = dao.joinRoom(db, "#r", "alice");

    assert.equal(result.was_new_member, true);
    assert.equal(
      dao.roomWatermark(db, "#r", "alice"),
      result.system_message?.id,
      "the watermark was not anchored at the announcement",
    );
    assert.deepEqual(
      dao.roomUnread(db, "#r", "alice").map((m) => m.body),
      [],
      "the joiner sees its own joined line as unread",
    );
  } finally {
    db.close();
  }
});
