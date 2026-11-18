import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { migrate, SCHEMA_VERSION } from "../../src/storage/db.js";
import * as dao from "../../src/storage/dao.js";

/**
 * The per-agent state the unread-backlog bands fire from (#224).
 *
 * 🛑 ONE COLUMN SO A BAND FIRES ONCE. Without it every check re-fires the same
 * band, which is what `context_warned_threshold` exists to prevent for the
 * context gauge. The two are separate columns on purpose: an agent can be low
 * on context and current on its inbox, or the reverse.
 */

function agent(handle = "me"): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  migrate(db);
  dao.upsertAgent(db, {
    handle,
    pid: 1,
    session_id: handle,
    display_name: handle,
    metadata: {},
  });

  return db;
}

test("🚨 a fresh agent has warned about no band yet", () => {
  const db = agent();
  try {
    assert.equal(dao.getAgent(db, "me")?.unread_warned_threshold, null);
  } finally {
    db.close();
  }
});

test("🚨 the band round-trips, and clears back to null", () => {
  const db = agent();
  try {
    dao.setAgentUnreadWarned(db, "me", 60);
    assert.equal(dao.getAgent(db, "me")?.unread_warned_threshold, 60);

    // 🛑 THE CLEAR IS THE HALF THAT MATTERS. An agent that caught up must be
    // able to fire again, so `null` has to be writable and not just absent.
    dao.setAgentUnreadWarned(db, "me", null);
    assert.equal(dao.getAgent(db, "me")?.unread_warned_threshold, null);
  } finally {
    db.close();
  }
});

/**
 * ⚠️ THE TWO COLUMNS MUST NOT BE THE SAME COLUMN. A single
 * `*_warned_threshold` would make a context warning silence a backlog warning,
 * and the two axes share no band values.
 */
test("🚨 writing the backlog band leaves the context band alone", () => {
  const db = agent();
  try {
    dao.setAgentContextWarned(db, "me", 85);
    dao.setAgentUnreadWarned(db, "me", 5);

    const me = dao.getAgent(db, "me");
    assert.equal(me?.context_warned_threshold, 85);
    assert.equal(me?.unread_warned_threshold, 5);
  } finally {
    db.close();
  }
});

/**
 * 🛑 A FLOOR AND AN EFFECT, NEVER AN EQUALITY. This asserted
 * `SCHEMA_VERSION === 16` and broke on the next migration added for an
 * unrelated feature, which is the brittleness `db.ts`'s own docblock names: a
 * literal version pinned in a test named for something else. The floor makes
 * DELETING this migration loud, and the column check is what actually proves
 * it ran.
 */
test("🚨 the migration that adds the column ran, and is not deleted", () => {
  assert.ok(
    SCHEMA_VERSION >= 16,
    `the schema went BACKWARDS to ${SCHEMA_VERSION}; migration 16 adds agents.unread_warned_threshold`,
  );

  const d = agent();
  try {
    const cols = (
      d.prepare(`PRAGMA table_info(agents)`).all() as unknown as {
        name: string;
      }[]
    ).map((c) => c.name);
    assert.ok(cols.includes("unread_warned_threshold"), cols.join(", "));
  } finally {
    d.close();
  }
});

/**
 * 🛑 THE WARNING MUST NOT BECOME ITS OWN BACKLOG.
 *
 * A `dm` band delivers to the agent's own inbox, so the warning arrives unread.
 * An agent that then reads every real message but not the warning would see
 * the warning's own age climb past the next band and fire again, for ever, off
 * nothing but the alarm. The axis is "a peer is waiting on you", and the
 * system is not a peer waiting on anything.
 */
test("🚨 a system message is not a backlog, so the alarm cannot feed itself", () => {
  const db = agent();
  try {
    const warning = dao.insertMessage(db, {
      from: dao.SYSTEM_HANDLE,
      to: "me",
      body: "🔵 You have unread bus messages",
    });
    db.prepare("UPDATE messages SET sent_at = ? WHERE id = ?").run(
      Date.now() - 300 * 60_000,
      warning.id,
    );

    assert.equal(dao.oldestUnreadAt(db, "me"), null);
    assert.equal(
      dao.pendingInboxCount(db, "me"),
      1,
      "the control: it IS unread, it just is not a backlog",
    );
  } finally {
    db.close();
  }
});

/** The negative control. A real peer's DM at the same age IS a backlog. */
test("🚨 a peer's DM at the same age IS a backlog", () => {
  const db = agent();
  try {
    dao.upsertAgent(db, {
      handle: "peer",
      pid: 2,
      session_id: "peer",
      display_name: "peer",
      metadata: {},
    });
    const dm = dao.insertMessage(db, { from: "peer", to: "me", body: "?" });
    const at = Date.now() - 300 * 60_000;
    db.prepare("UPDATE messages SET sent_at = ? WHERE id = ?").run(at, dm.id);

    assert.equal(dao.oldestUnreadAt(db, "me"), at);
  } finally {
    db.close();
  }
});

/**
 * ⚠️ THE SYSTEM EXCLUSION APPLIES IN ROOMS TOO, and the fixture has to work for
 * it. `joinRoom` anchors the JOINER's own watermark past its own announcement,
 * so a single-member room leaves nothing unread and the assertion below would
 * pass with no exclusion at all. A SECOND agent joining is what writes a
 * system row this agent has not read.
 */
test("🚨 a system room announcement is not a backlog either", () => {
  const db = agent();
  try {
    dao.joinRoom(db, "#r", "me");
    dao.upsertAgent(db, {
      handle: "other",
      pid: 2,
      session_id: "other",
      display_name: "other",
      metadata: {},
    });
    dao.joinRoom(db, "#r", "other");

    db.prepare(
      "UPDATE messages SET sent_at = ? WHERE to_handle = '#r' AND from_handle = ?",
    ).run(Date.now() - 300 * 60_000, dao.SYSTEM_HANDLE);

    // The fixture's own control: the row IS unread to me, it just is not mine
    // to answer. Without this the test could pass on an empty room.
    assert.equal(
      dao.roomUnreadCount(db, "#r", "me"),
      1,
      "fixture: the second join IS unread to me",
    );
    assert.equal(dao.oldestUnreadAt(db, "me"), null);
  } finally {
    db.close();
  }
});
