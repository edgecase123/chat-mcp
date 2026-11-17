import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { migrate } from "../../src/storage/db.js";
import * as dao from "../../src/storage/dao.js";

/**
 * 🛑 THE AXIS IS AGE, NOT DEPTH, AND THAT WAS MEASURED.
 *
 * Over the live `chat.db` no agent ever held more than 6 unread DMs, while 26
 * messages sat unread with the recipient demonstrably still sending — one with
 * 142 sends while a DM waited. Depth cannot separate those from routine
 * traffic. Age can: p50 0.2 min, p95 407 min.
 *
 * This file pins the READ that feeds `shim/backlog.ts`. The band machine is
 * pure and already tested; what it cannot test is whether the number handed to
 * it describes a message an `inbox` call would actually return.
 */

const MIN = 60_000;

function busWithTwoAgents(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  migrate(db);
  for (const h of ["me", "other"]) {
    dao.upsertAgent(db, {
      handle: h,
      pid: 1,
      session_id: h,
      display_name: h,
      metadata: {},
    });
    dao.joinRoom(db, "#r", h);
  }

  // 🛑 EACH join WRITES A SYSTEM MESSAGE and the second is unread to the
  // first joiner. An unflushed watermark makes every age the fixture's own,
  // which reads as a passing filter rather than a dirty fixture.
  const newest = db
    .prepare(
      "SELECT COALESCE(MAX(id), 0) AS n FROM messages WHERE to_handle = '#r'",
    )
    .get() as unknown as { n: number };
  for (const h of ["me", "other"])
    dao.advanceRoomRead(db, "#r", h, Number(newest.n));

  assert.equal(
    dao.totalUnreadFor(db, "me"),
    0,
    "fixture starts with nothing unread for me",
  );
  assert.equal(
    dao.oldestUnreadAt(db, "me"),
    null,
    "fixture starts with no backlog for me",
  );

  return db;
}

/** Backdate a message so a test can state an age without waiting for one. */
function age(db: DatabaseSync, id: number, minutes: number): number {
  const at = Date.now() - minutes * MIN;
  db.prepare("UPDATE messages SET sent_at = ? WHERE id = ?").run(at, id);
  return at;
}

test("🚨 nothing unread is null, not zero", () => {
  const db = busWithTwoAgents();
  try {
    assert.equal(dao.oldestUnreadAt(db, "me"), null);
  } finally {
    db.close();
  }
});

test("🚨 an unread DM reports its own sent_at", () => {
  const db = busWithTwoAgents();
  try {
    const sent = dao.insertMessage(db, { from: "other", to: "me", body: "a" });
    const at = age(db, sent.id, 30);

    assert.equal(dao.oldestUnreadAt(db, "me"), at);
  } finally {
    db.close();
  }
});

test("🚨 an unread ROOM message reports its own sent_at", () => {
  const db = busWithTwoAgents();
  try {
    const sent = dao.insertMessage(db, { from: "other", to: "#r", body: "a" });
    const at = age(db, sent.id, 30);

    assert.equal(dao.oldestUnreadAt(db, "me"), at);
  } finally {
    db.close();
  }
});

/**
 * 🛑 THE DISCRIMINATING TEST. A DM-only or room-only query passes both single
 * channel tests above. Only the cross-channel minimum catches it, in both
 * directions — whichever channel holds the older message must win.
 */
test("🚨 the OLDER of the two channels wins, whichever channel it is", () => {
  const db = busWithTwoAgents();
  try {
    const dm = dao.insertMessage(db, { from: "other", to: "me", body: "dm" });
    const room = dao.insertMessage(db, { from: "other", to: "#r", body: "rm" });

    const oldDm = age(db, dm.id, 90);
    age(db, room.id, 10);
    assert.equal(dao.oldestUnreadAt(db, "me"), oldDm, "the DM is older");

    age(db, dm.id, 10);
    const oldRoom = age(db, room.id, 90);
    assert.equal(dao.oldestUnreadAt(db, "me"), oldRoom, "the room is older");
  } finally {
    db.close();
  }
});

/**
 * 🛑 MUST CARRY `roomUnreadCount`'s OWN FILTER. `room_send` does not advance
 * the sender's watermark, so an agent's own post is unread to the row but not
 * to the agent. Counting it means a silent agent alarms about itself.
 */
test("🚨 my own room post is not a backlog of mine", () => {
  const db = busWithTwoAgents();
  try {
    const mine = dao.insertMessage(db, { from: "me", to: "#r", body: "mine" });
    age(db, mine.id, 300);

    assert.equal(dao.oldestUnreadAt(db, "me"), null);
    assert.equal(dao.roomUnreadCount(db, "#r", "me"), 0, "the control");
  } finally {
    db.close();
  }
});

/** The negative control for the test above: a sibling's post DOES count. */
test("🚨 a sibling's room post IS a backlog, so the filter drops only mine", () => {
  const db = busWithTwoAgents();
  try {
    const theirs = dao.insertMessage(db, {
      from: "other",
      to: "#r",
      body: "theirs",
    });
    const at = age(db, theirs.id, 300);

    assert.equal(dao.oldestUnreadAt(db, "me"), at);
  } finally {
    db.close();
  }
});

test("🚨 reading the DM clears it from the backlog", () => {
  const db = busWithTwoAgents();
  try {
    const sent = dao.insertMessage(db, { from: "other", to: "me", body: "a" });
    age(db, sent.id, 300);

    dao.markRead(db, [sent.id]);

    assert.equal(dao.oldestUnreadAt(db, "me"), null);
  } finally {
    db.close();
  }
});

test("🚨 advancing the room watermark clears it from the backlog", () => {
  const db = busWithTwoAgents();
  try {
    const sent = dao.insertMessage(db, { from: "other", to: "#r", body: "a" });
    age(db, sent.id, 300);

    dao.advanceRoomRead(db, "#r", "me", sent.id);

    assert.equal(dao.oldestUnreadAt(db, "me"), null);
  } finally {
    db.close();
  }
});

/**
 * 🛑 MEMBERSHIP IS THE SCOPE, NOT THE MESSAGE'S EXISTENCE. A query over every
 * `#`-addressed row would hand an agent an alarm about a room it cannot read,
 * and no read it can make would ever clear it.
 */
test("🚨 a room I am not in is not my backlog", () => {
  const db = busWithTwoAgents();
  try {
    dao.joinRoom(db, "#elsewhere", "other");
    const sent = dao.insertMessage(db, {
      from: "other",
      to: "#elsewhere",
      body: "a",
    });
    age(db, sent.id, 300);

    assert.equal(dao.oldestUnreadAt(db, "me"), null);
  } finally {
    db.close();
  }
});

/**
 * 🛑 A BACKLOG IMPLIES SOMETHING UNREAD. The age and the count read the same
 * rows, so an age with a zero count means one of the two filters drifted —
 * which is exactly how `roomUnreadCount` and `roomUnread` once disagreed.
 *
 * ⚠️ THE CONVERSE IS FALSE, DELIBERATELY, AND THE LAST ARRANGEMENT PROVES IT.
 * A system message is unread and is NOT a backlog, because the axis is "a peer
 * is waiting on you". Asserting `iff` here would forbid that exclusion, and
 * without the exclusion a `dm` band's own warning becomes the next band's
 * input. `backlog-warned-column.test.ts` owns that case.
 */
test("🚨 a backlog always implies something unread, but not the reverse", () => {
  const db = busWithTwoAgents();
  try {
    const arrangements: Array<readonly [string, () => void]> = [
      ["nothing", () => {}],
      [
        "my own room post",
        () =>
          void dao.insertMessage(db, { from: "me", to: "#r", body: "mine" }),
      ],
      [
        "a peer DM",
        () =>
          void dao.insertMessage(db, { from: "other", to: "me", body: "dm" }),
      ],
      [
        "a peer room post",
        () =>
          void dao.insertMessage(db, { from: "other", to: "#r", body: "rm" }),
      ],
    ];

    for (const [name, arrange] of arrangements) {
      arrange();
      if (dao.oldestUnreadAt(db, "me") !== null)
        assert.ok(
          dao.totalUnreadFor(db, "me") > 0,
          `${name}: a backlog with nothing unread means a filter drifted`,
        );
    }

    // The documented one-way case, asserted rather than described.
    const db2 = busWithTwoAgents();
    try {
      dao.insertMessage(db2, {
        from: dao.SYSTEM_HANDLE,
        to: "me",
        body: "a warning",
      });
      assert.equal(dao.oldestUnreadAt(db2, "me"), null, "not a backlog");
      assert.equal(dao.totalUnreadFor(db2, "me"), 1, "but it IS unread");
    } finally {
      db2.close();
    }
  } finally {
    db.close();
  }
});
