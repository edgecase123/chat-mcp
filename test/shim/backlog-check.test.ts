import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 🛑 BEFORE any import that resolves a state path — notifyPeer writes there.
process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), "chat-mcp-backlog-"));

const { migrate } = await import("../../src/storage/db.js");
const dao = await import("../../src/storage/dao.js");
const { applyBacklogCheck, tickBacklogSafely } =
  await import("../../src/shim/backlog-check.js");
const { deadPid } = await import("../support/dead-pid.js");

/**
 * #224 defect 2, unit 3b — the seam that makes the bands fire.
 *
 * The tick is the agent's OWN `send` / `room_send`, ruled by lee 2026-11-17.
 * An agent that is sending is demonstrably alive, so an unread message it has
 * left waiting is being ignored rather than merely undelivered.
 */

const MIN = 60_000;

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  migrate(db);
  for (const handle of ["me", "peer"]) {
    dao.upsertAgent(db, { handle, pid: deadPid(), session_id: handle });
  }

  return db;
}

/** A DM from `peer` to `me`, sent `minutesAgo` before `now`. */
function dmAgedBy(
  db: DatabaseSync,
  now: number,
  minutesAgo: number,
): { id: number } {
  const sent = dao.insertMessage(db, {
    from: "peer",
    to: "me",
    body: "are you there",
    kind: "chat",
  });
  db.prepare(`UPDATE messages SET sent_at = ? WHERE id = ?`).run(
    now - minutesAgo * MIN,
    sent.id,
  );

  return { id: sent.id };
}

test("an empty inbox fires nothing and stores nothing", () => {
  const db = freshDb();

  const out = applyBacklogCheck(db, "me", Date.now());

  assert.equal(out.minutes, null);
  assert.equal(out.fired, null);
  assert.equal(out.warned, null);
  assert.equal(dao.getAgent(db, "me")?.unread_warned_threshold, null);
});

test("a fresh unread message is below the first band", () => {
  const db = freshDb();
  const now = Date.now();
  dmAgedBy(db, now, 2);

  const out = applyBacklogCheck(db, "me", now);

  assert.equal(out.minutes, 2);
  assert.equal(out.fired, null, "2 minutes is under the 5-minute band");
});

test("crossing the first band DMs the agent and records the band", () => {
  const db = freshDb();
  const now = Date.now();
  dmAgedBy(db, now, 6);

  const out = applyBacklogCheck(db, "me", now);

  assert.equal(out.fired, 5);
  assert.equal(out.notified.dm, 1);
  assert.deepEqual(out.notified.rooms, []);
  assert.equal(dao.getAgent(db, "me")?.unread_warned_threshold, 5);

  const warnings = dao
    .pendingInbox(db, { to: "me" })
    .filter((m) => m.from_handle === dao.SYSTEM_HANDLE);
  assert.equal(warnings.length, 1, "the warning reaches the agent's own inbox");
  assert.match(String(warnings[0]!.body), /6 min/);
});

test("a band fires ONCE however many times the seam ticks", () => {
  const db = freshDb();
  const now = Date.now();
  dmAgedBy(db, now, 6);

  assert.equal(applyBacklogCheck(db, "me", now).fired, 5);
  const second = applyBacklogCheck(db, "me", now + MIN);

  assert.equal(second.fired, null, "still inside the 5-minute band");
  assert.equal(second.warned, 5, "the stored band is unchanged");
});

test("climbing into the next band fires again", () => {
  const db = freshDb();
  const now = Date.now();
  dmAgedBy(db, now, 6);

  applyBacklogCheck(db, "me", now);
  const out = applyBacklogCheck(db, "me", now + 10 * MIN);

  assert.equal(out.fired, 15);
  assert.equal(dao.getAgent(db, "me")?.unread_warned_threshold, 15);
});

test("catching up CLEARS the stored band, so a fresh climb can fire again", () => {
  const db = freshDb();
  const now = Date.now();
  const dm = dmAgedBy(db, now, 6);

  applyBacklogCheck(db, "me", now);
  dao.markRead(db, [dm.id]);

  const cleared = applyBacklogCheck(db, "me", now + MIN);
  assert.equal(cleared.minutes, null, "nothing is waiting any more");
  assert.equal(cleared.warned, null);
  assert.equal(dao.getAgent(db, "me")?.unread_warned_threshold, null);

  dmAgedBy(db, now + 2 * MIN, 6);
  const again = applyBacklogCheck(db, "me", now + 2 * MIN);
  assert.equal(again.fired, 5, "the same band is a new incident, not chatter");
});

test("🛑 the warning the seam DELIVERED cannot keep the alarm firing", () => {
  const db = freshDb();
  const now = Date.now();
  const dm = dmAgedBy(db, now, 6);

  assert.equal(applyBacklogCheck(db, "me", now).fired, 5);

  // The agent reads the REAL message and leaves the system warning unread.
  dao.markRead(db, [dm.id]);

  // 🛑 THE NON-VACUITY CONTROL. Without this the assertion below is true of an
  // empty set, which is exactly how a one-member-room version of this test
  // passed before the code it tests existed.
  const stillUnread = dao
    .pendingInbox(db, { to: "me" })
    .filter((m) => m.from_handle === dao.SYSTEM_HANDLE);
  assert.equal(stillUnread.length, 1, "the warning IS unread");

  const out = applyBacklogCheck(db, "me", now + 300 * MIN);

  assert.equal(
    out.minutes,
    null,
    "a system warning is unread and is NOT a backlog",
  );
  assert.equal(out.fired, null, "the alarm cannot fire off its own alarm");
});

test("the 60-minute band leaves the DM channel for the room", () => {
  const db = freshDb();
  const now = Date.now();
  dao.joinRoom(db, "#gate", "me");
  dao.joinRoom(db, "#gate", "peer");
  dmAgedBy(db, now, 61);

  const out = applyBacklogCheck(db, "me", now);

  assert.equal(out.fired, 60);
  assert.equal(out.notified.dm, 0, "a DM is evidently not reaching them");
  assert.deepEqual(out.notified.rooms, ["#gate"]);
});

test("the 240-minute band posts to the room as an alert", () => {
  const db = freshDb();
  const now = Date.now();
  dao.joinRoom(db, "#gate", "me");
  dao.joinRoom(db, "#gate", "peer");
  dmAgedBy(db, now, 241);

  const out = applyBacklogCheck(db, "me", now);

  assert.equal(out.fired, 240);
  assert.deepEqual(out.notified.rooms, ["#gate"]);

  const posted = dao
    .roomUnread(db, "#gate", "peer")
    .filter((m) => m.from_handle === dao.SYSTEM_HANDLE);
  assert.equal(posted.length, 1);
  assert.equal(posted[0]!.kind, "alert");
});

test("🛑 a FAILING check cannot fail the send that already happened", () => {
  const db = freshDb();
  const now = Date.now();
  dmAgedBy(db, now, 6);

  // A closed handle is a real failure mode, not a mock: the send's own insert
  // has already run and committed by the time the tick is reached.
  db.close();

  let out: ReturnType<typeof tickBacklogSafely> | undefined;
  assert.doesNotThrow(() => {
    out = tickBacklogSafely(db, "me", now);
  }, "the tick must never reach the caller as a throw");

  assert.equal(out, null, "a failed tick reports null rather than a reading");
});

test("the safe tick returns the reading when nothing fails", () => {
  const db = freshDb();
  const now = Date.now();
  dmAgedBy(db, now, 6);

  const out = tickBacklogSafely(db, "me", now);

  assert.equal(out?.fired, 5, "the wrapper does not change the behaviour");
  assert.equal(out?.notified.dm, 1);
});
