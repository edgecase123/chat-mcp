import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 🛑 SET BEFORE THE IMPORTS BELOW. `notifyPeer` resolves `stateDir()`
 * transitively, so a static import here would bind the operator's live
 * `~/.chat-mcp` and write real notify files. Same reason as `room-send.test.ts`.
 */
process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), "chat-mcp-announce-"));

const { DatabaseSync } = await import("node:sqlite");
const { migrate } = await import("../../src/storage/db.js");
const dao = await import("../../src/storage/dao.js");
const { announceToRoom } = await import("../../src/messaging/room-announce.js");

const NOTIFY = join(process.env.CHAT_MCP_HOME, "notify");

test.after(() =>
  rmSync(process.env.CHAT_MCP_HOME as string, {
    recursive: true,
    force: true,
  }),
);

/**
 * #138 — the boot announcement had NO test at all, on any of its three
 * surfaces.
 *
 * ⚠️ MEASURED BEFORE WRITING THIS: `bootFromRoom` appeared once in `test/`, in
 * a search-scoping test that never looks at the announcement, and `room_boot`
 * only in a list of registered tool names. So the refactor that routed all
 * three through `insertMessage` had nothing to fail.
 */

function room(members: string[] = ["claude1", "claude2", "gate"]) {
  const db = new DatabaseSync(":memory:");
  migrate(db);

  for (const h of members) {
    dao.upsertAgent(db, {
      handle: h,
      pid: 1,
      session_id: h,
      display_name: h,
      metadata: {},
    });
    dao.joinRoom(db, "#gate", h);
  }

  return db;
}

/** Notify files present, so a fan-out can be counted rather than inferred. */
function notified(): string[] {
  try {
    return readdirSync(NOTIFY).sort();
  } catch {
    return [];
  }
}

test("🚨 the announcement is a real messages row, written by the system handle", () => {
  const db = room();

  const sent = announceToRoom(db, {
    room: "#gate",
    body: "claude1 booted claude2 from #gate",
    actor: "claude1",
    advanceActorRead: false,
  });

  const row = db
    .prepare(
      "SELECT from_handle, to_handle, body, sent_at FROM messages WHERE id = ?",
    )
    .get(sent.id) as unknown as
    | { from_handle: string; to_handle: string; body: string; sent_at: number }
    | undefined;

  assert.ok(row, `id ${sent.id} does not name a row, so the id is fiction`);
  assert.equal(row.from_handle, dao.SYSTEM_HANDLE);
  assert.equal(row.to_handle, "#gate");
  assert.equal(row.body, "claude1 booted claude2 from #gate");

  // ⚠️ THE RETURNED STAMP MUST BE THE ROW'S. Three surfaces return it to their
  // caller, and the raw inserts used a local `now` that `insertMessage` does not
  // see.
  assert.equal(row.sent_at, sent.sent_at);
});

test("🚨 every member but the ACTOR is woken", () => {
  const db = room();

  const sent = announceToRoom(db, {
    room: "#gate",
    body: "claude1 booted claude2 from #gate",
    actor: "claude1",
    advanceActorRead: false,
  });

  assert.equal(sent.notified, 2, "expected claude2 and gate, not the actor");

  // The denominator: a fan-out that wrote nothing would make the count above a
  // claim about a loop that never ran.
  const files = notified();

  assert.ok(files.includes("claude2"), `claude2 was not woken: ${files}`);
  assert.ok(files.includes("gate"), `gate was not woken: ${files}`);
  assert.ok(
    !files.includes("claude1"),
    `the actor was woken by its own action: ${files}`,
  );
});

/**
 * 🛑 THE PARAMETER HAS NO DEFAULT BECAUSE THE SURFACES DISAGREE, so both
 * answers are tested. The REPL advances to stop the announcement echoing back on
 * its next flushInbox; the oneshot verb and the MCP tool have no inbox of their
 * own to keep clear.
 */
test("🚨 advanceActorRead true moves the actor's watermark past the announcement", () => {
  const db = room();

  const sent = announceToRoom(db, {
    room: "#gate",
    body: "claude1 booted claude2 from #gate",
    actor: "claude1",
    advanceActorRead: true,
  });

  assert.equal(
    dao.roomUnreadCount(db, "#gate", "claude1"),
    0,
    "the actor still has the announcement unread",
  );

  // The paired half. Without it, a watermark that swallowed EVERYTHING would
  // satisfy the assertion above.
  assert.ok(
    dao.roomUnreadCount(db, "#gate", "claude2") > 0,
    "claude2 cannot see the announcement, so the watermark moved for everyone",
  );
  assert.ok(sent.id > 0);
});

test("🚨 advanceActorRead false leaves the actor's watermark alone", () => {
  const db = room();

  announceToRoom(db, {
    room: "#gate",
    body: "claude1 booted claude2 from #gate",
    actor: "claude1",
    advanceActorRead: false,
  });

  assert.ok(
    dao.roomUnreadCount(db, "#gate", "claude1") > 0,
    "the actor's watermark advanced although it was told not to",
  );
});
