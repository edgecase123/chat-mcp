import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { migrate } from "../../src/storage/db.js";
import * as dao from "../../src/storage/dao.js";

/**
 * A partway failure in `joinRoom` used to leave a member row with no
 * `room_reads` row.
 *
 * 🛑 THE UNREPAIRABILITY IS THE DEFECT, NOT THE THROW. `roomWatermark` falls
 * back to 0 without that row, so the agent re-reads the room's whole history
 * as unread — and the idempotence short-circuit returns before the watermark
 * write, so every retry reports `was_new_member: false` and repairs nothing.
 *
 * 🛑 THE ANNOUNCE IS OUTSIDE THE TRANSACTION, AND THAT ORDER IS FORCED.
 * `insertMessage` proves its row landed by re-reading it on a SECOND
 * connection, which cannot see an uncommitted row — so an announce inside the
 * transaction makes every file-backed join throw. The watermark is anchored to
 * the announce's own id, so the announce cannot move after the commit either.
 */

function memDb(): DatabaseSync {
  const d = new DatabaseSync(":memory:");
  migrate(d);
  for (const h of ["alice", "bob"]) {
    dao.upsertAgent(d, {
      handle: h,
      pid: 1,
      session_id: h,
      display_name: h,
      metadata: {},
    });
  }

  return d;
}

/**
 * Make the announcement throw, the way `insertMessage` does when its row does
 * not land.
 *
 * ⚠️ A TRIGGER, NOT A MOCK. `joinRoom` calls `insertMessage` inside its own
 * module, so module mocking cannot reach that call — and a stubbed `joinRoom`
 * would be a test of the stub.
 */
function breakMessageInserts(d: DatabaseSync): void {
  d.exec(
    `CREATE TRIGGER no_messages BEFORE INSERT ON messages
     BEGIN SELECT RAISE(ABORT, 'simulated insert failure'); END`,
  );
}

/**
 * 🛑 THE ONLY TRIGGER THAT REACHES INSIDE THE TRANSACTION. Under the ruled
 * design the announce fails BEFORE the transaction opens, so a broken
 * `messages` insert cannot prove the rollback — it proves only that nothing
 * had been written yet.
 */
function breakReadInserts(d: DatabaseSync): void {
  d.exec(
    `CREATE TRIGGER no_reads BEFORE INSERT ON room_reads
     BEGIN SELECT RAISE(ABORT, 'simulated watermark failure'); END`,
  );
}

const countRows = (d: DatabaseSync, table: string, room: string, h: string) =>
  (
    d
      .prepare(
        `SELECT COUNT(*) AS n FROM ${table} WHERE room_name = ? AND handle = ?`,
      )
      .get(room, h) as unknown as { n: number }
  ).n;

test("🚨 a watermark failure rolls the membership row back with it", () => {
  const d = memDb();

  breakReadInserts(d);

  assert.throws(() => dao.joinRoom(d, "#r", "alice"));

  assert.equal(
    countRows(d, "room_members", "#r", "alice"),
    0,
    "the membership row outlived the watermark write, so this agent re-reads the room forever",
  );
  assert.equal(countRows(d, "room_reads", "#r", "alice"), 0);
});

test("a failed announcement leaves no membership behind", () => {
  const d = memDb();

  breakMessageInserts(d);

  assert.throws(() => dao.joinRoom(d, "#r", "alice"));

  assert.equal(countRows(d, "room_members", "#r", "alice"), 0);
  assert.equal(countRows(d, "room_reads", "#r", "alice"), 0);
});

/**
 * POSITIVE CONTROL. Without it a `joinRoom` that threw before writing anything
 * would satisfy both tests above while proving nothing.
 */
test("a clean join writes the room, the member, the announcement and the watermark", () => {
  const d = memDb();

  const result = dao.joinRoom(d, "#r", "alice");

  assert.equal(result.was_new_member, true);
  assert.equal(dao.roomExists(d, "#r"), true);
  assert.equal(countRows(d, "room_members", "#r", "alice"), 1);
  assert.equal(countRows(d, "room_reads", "#r", "alice"), 1);
  assert.ok((result.system_message?.id ?? 0) > 0, "no announcement id");
  assert.equal(
    dao.roomWatermark(d, "#r", "alice"),
    result.system_message?.id,
    "the watermark was not anchored at the announcement",
  );
});

/**
 * 🛑 THE CONSEQUENCE THE TICKET IS ABOUT. A retry after a failed join must
 * produce a joined agent with nothing unread.
 */
test("🚨 a join retried after a failure anchors the watermark instead of reporting success", () => {
  const d = memDb();

  dao.joinRoom(d, "#r", "bob");
  dao.insertMessage(d, { from: "bob", to: "#r", body: "history one" });
  dao.insertMessage(d, { from: "bob", to: "#r", body: "history two" });

  breakReadInserts(d);
  assert.throws(() => dao.joinRoom(d, "#r", "alice"));
  d.exec(`DROP TRIGGER no_reads`);

  const retry = dao.joinRoom(d, "#r", "alice");

  assert.equal(
    retry.was_new_member,
    true,
    "the retry was short-circuited by a membership row the failure left behind",
  );
  assert.ok(dao.roomWatermark(d, "#r", "alice") > 0);
  assert.deepEqual(
    dao.roomUnread(d, "#r", "alice").map((m) => m.body),
    [],
    "the retried joiner re-reads the room's history as unread",
  );
});
