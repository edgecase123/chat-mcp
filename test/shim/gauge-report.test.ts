import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 🛑 BEFORE any import that resolves a state path — notifyPeer writes there.
process.env.CHAT_MCP_HOME = mkdtempSync(
  join(tmpdir(), "chat-mcp-gaugereport-"),
);

const { migrate } = await import("../../src/storage/db.js");
const dao = await import("../../src/storage/dao.js");
const { applyContextReport } = await import("../../src/shim/gauge-report.js");
const { deadPid } = await import("../support/dead-pid.js");
const { breakMemberLookup, breakRoom, quietStderr, warningsIn } =
  await import("../support/warning-fanout.js");

/**
 * 🛑 THE WRITE, THE HYSTERESIS AND THE FANOUT WERE COPIED IN TWO FILES, and
 * #213 wants the supervisor to be a third. `gauge.ts` already de-duplicated
 * the band LITERALS; everything around them stayed duplicated.
 */

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  migrate(db);
  dao.upsertAgent(db, {
    handle: "claude9",
    pid: deadPid(),
    session_id: "claude9",
  });

  return db;
}

test("the reading lands on the agent row", () => {
  const db = freshDb();

  applyContextReport(db, "claude9", 120_000, 1_000_000);

  const me = dao.getAgent(db, "claude9");
  assert.equal(me?.context_used, 120_000);
  assert.equal(me?.context_total, 1_000_000);
});

test("the payload carries the percent to one decimal", () => {
  const db = freshDb();

  const out = applyContextReport(db, "claude9", 118_783, 1_000_000);

  assert.equal(out.percent, 11.9);
  assert.equal(out.fired, null, "nothing is crossed at 11.9%");
});

test("crossing the planning band DMs the agent and records the band", () => {
  const db = freshDb();

  const out = applyContextReport(db, "claude9", 510_000, 1_000_000);

  assert.equal(out.fired, 50);
  assert.equal(out.notified.dm, 1);
  assert.deepEqual(
    out.notified.rooms,
    [],
    "a plan is not an escalation, so no room post",
  );
  assert.equal(dao.getAgent(db, "claude9")?.context_warned_threshold, 50);
});

test("crossing the room band posts to every room the agent is in", () => {
  const db = freshDb();
  dao.upsertAgent(db, {
    handle: "claude8",
    pid: deadPid(),
    session_id: "claude8",
  });
  dao.joinRoom(db, "#gate", "claude9");
  dao.joinRoom(db, "#gate", "claude8");

  const out = applyContextReport(db, "claude9", 860_000, 1_000_000);

  assert.equal(out.fired, 85);
  assert.deepEqual(out.notified.rooms, ["#gate"]);
  assert.equal(out.notified.dm, 0);
});

/**
 * ⚠️ THE SECOND REPORT IS THE ONE THAT CHATTERS. A gauge sitting just over a
 * band re-reports on every turn, and without the stored threshold each one
 * would fire again.
 */
test("sitting inside a band already warned fires nothing the second time", () => {
  const db = freshDb();

  assert.equal(applyContextReport(db, "claude9", 510_000, 1_000_000).fired, 50);
  const second = applyContextReport(db, "claude9", 520_000, 1_000_000);

  assert.equal(second.fired, null);
  assert.equal(second.notified.dm, 0);
});

/**
 * 🛑 AN UNREGISTERED HANDLE IS THE CALLER'S POLICY, NOT THIS FUNCTION'S. The
 * hook must never throw inside a PreToolUse, the MCP tool wants to say so.
 * Both decide before calling; this one just must not crash.
 */
test("an unknown handle does not throw here", () => {
  const db = freshDb();

  assert.doesNotThrow(() => applyContextReport(db, "nobody", 1, 10));
});

/**
 * Two rooms, both holding the reporter and a peer, so a room that was skipped
 * is visible as an empty table rather than inferred.
 */
function twoRooms(db: DatabaseSync): void {
  dao.upsertAgent(db, { handle: "peer", pid: deadPid(), session_id: "peer" });

  for (const room of ["#aaa", "#zzz"]) {
    dao.joinRoom(db, room, "claude9");
    dao.joinRoom(db, room, "peer");
  }
}

/**
 * 🛑 THE BAND IS SPENT BEFORE THE DELIVERY IS ATTEMPTED, so a throw part-way
 * through the fanout costs the rooms below it their only warning. A spent band
 * never fires again, and the gauge is the signal an operator acts on.
 */
test("🛑 a failed MEMBER LOOKUP still warns every room, and warns each once", () => {
  const db = freshDb();
  twoRooms(db);
  breakMemberLookup(db);

  const stderr = quietStderr();
  try {
    for (const used of [860_000, 870_000, 880_000]) {
      applyContextReport(db, "claude9", used, 1_000_000);
    }
  } finally {
    stderr.restore();
  }

  // The row IS the delivery — `room_inbox` reads the table — so an unreachable
  // audience must not discard a row that already committed.
  assert.equal(warningsIn(db, "#aaa").length, 1, "warned once, not per report");
  assert.equal(warningsIn(db, "#zzz").length, 1, "warned once, not per report");
  assert.equal(dao.getAgent(db, "claude9")?.context_warned_threshold, 85);

  // Non-vacuity: without a real throw the counts above hold for the wrong
  // reason, so the injection has to prove it fired, once per room, once only.
  assert.equal(stderr.lines.length, 2, "one firing round, both rooms failing");
  assert.match(stderr.lines[0]!, /undelivered to #aaa for claude9/);
  assert.match(stderr.lines[1]!, /undelivered to #zzz for claude9/);
});

/**
 * 🛑 THE OPPOSITE BUG. Spending the band when NOTHING was delivered leaves the
 * agent with no warning at all, because a spent band never fires again.
 */
test("🛑 a band nothing could be delivered for is NOT spent, and retries", () => {
  const db = freshDb();
  twoRooms(db);
  breakRoom(db, "#aaa");
  breakRoom(db, "#zzz");

  const stderr = quietStderr();
  let first;
  try {
    first = applyContextReport(db, "claude9", 860_000, 1_000_000);
  } finally {
    stderr.restore();
  }

  assert.deepEqual(first.notified.rooms, [], "no room took the row");
  assert.equal(first.fired, null, "nothing fired, because nothing landed");
  assert.equal(
    dao.getAgent(db, "claude9")?.context_warned_threshold,
    null,
    "the band must stay unspent so a later report can retry it",
  );
  assert.equal(stderr.lines.length, 2, "both rooms reported undelivered");

  // The retry is the point of leaving it unspent, so prove it actually fires.
  db.exec(`DROP TRIGGER break_aaa`);
  db.exec(`DROP TRIGGER break_zzz`);

  const second = applyContextReport(db, "claude9", 870_000, 1_000_000);

  assert.equal(second.fired, 85, "the band was still there to cross");
  assert.deepEqual(second.notified.rooms, ["#aaa", "#zzz"]);
});
