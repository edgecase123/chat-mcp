import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { migrate, SCHEMA_VERSION } from "../../src/storage/db.js";
import * as dao from "../../src/storage/dao.js";
import {
  DEFAULT_CONTEXT_GATE,
  getGlobalContextGate,
  resolveContextGate,
  setGlobalContextGate,
  setHandleContextGate,
} from "../../src/storage/context-gate.js";

/**
 * The restart threshold a supervised agent is measured against (#135).
 *
 * lee ruled the shape on 2026-11-09: a global default with a per-handle
 * override, and a default of 50. The value drives an automatic restart, so
 * every path that could yield a number has to yield a SAFE one.
 */

function db(...handles: string[]): DatabaseSync {
  const d = new DatabaseSync(":memory:");
  migrate(d);
  for (const [i, handle] of handles.entries()) {
    dao.upsertAgent(d, {
      handle,
      pid: i + 1,
      session_id: handle,
      display_name: handle,
      metadata: {},
    });
  }

  return d;
}

test("🚨 the default protects a handle nobody has configured", () => {
  const d = db("a");
  try {
    assert.equal(DEFAULT_CONTEXT_GATE, 50, "lee ruled 50 on 2026-11-09");
    assert.equal(getGlobalContextGate(d), null, "nothing is set yet");
    assert.equal(resolveContextGate(d, "a"), 50);
  } finally {
    d.close();
  }
});

/**
 * 🛑 THE UNREGISTERED HANDLE IS THE CASE THAT MATTERS. The override lives on
 * `agents`, so a handle with no row has no column to read. The ticket's own
 * ruling is that a new handle is protected immediately, which means the
 * absence of a row must resolve to the global and never throw.
 */
test("🚨 a handle with no agents row still resolves, to the global", () => {
  const d = db();
  try {
    assert.equal(resolveContextGate(d, "never-registered"), 50);
    setGlobalContextGate(d, 80);
    assert.equal(resolveContextGate(d, "never-registered"), 80);
  } finally {
    d.close();
  }
});

test("🚨 the global moves every handle that has no override", () => {
  const d = db("a", "b");
  try {
    setGlobalContextGate(d, 80);
    assert.equal(getGlobalContextGate(d), 80);
    assert.equal(resolveContextGate(d, "a"), 80);
    assert.equal(resolveContextGate(d, "b"), 80);
  } finally {
    d.close();
  }
});

test("🚨 a per-handle override beats the global, for that handle only", () => {
  const d = db("a", "b");
  try {
    setGlobalContextGate(d, 80);
    setHandleContextGate(d, "a", 30);

    assert.equal(resolveContextGate(d, "a"), 30);
    assert.equal(resolveContextGate(d, "b"), 80, "b is untouched");
  } finally {
    d.close();
  }
});

/**
 * 🛑 THE CLEAR IS THE HALF THAT MATTERS, same as the warned-threshold columns.
 * Without a writable null there is no way back to the global short of editing
 * SQLite by hand.
 */
test("🚨 clearing an override falls back to the global, not to the default", () => {
  const d = db("a");
  try {
    setGlobalContextGate(d, 80);
    setHandleContextGate(d, "a", 30);
    setHandleContextGate(d, "a", null);

    assert.equal(resolveContextGate(d, "a"), 80);
  } finally {
    d.close();
  }
});

test("🚨 an override set before any global survives the global being unset", () => {
  const d = db("a");
  try {
    setHandleContextGate(d, "a", 30);

    assert.equal(getGlobalContextGate(d), null);
    assert.equal(resolveContextGate(d, "a"), 30);
  } finally {
    d.close();
  }
});

/**
 * 🛑 A GATE OF 0 WOULD RESTART EVERY AGENT ON TURN 0, AND 101 WOULD NEVER
 * RESTART ONE. Both are worse than the default, so neither may be stored.
 */
test("🚨 an out-of-range or non-integer gate is refused, on both setters", () => {
  const d = db("a");
  try {
    for (const bad of [0, -1, 101, 1000, 50.5, NaN, Infinity]) {
      assert.throws(
        () => setGlobalContextGate(d, bad),
        /context gate/i,
        `global accepted ${bad}`,
      );
      assert.throws(
        () => setHandleContextGate(d, "a", bad),
        /context gate/i,
        `handle accepted ${bad}`,
      );
    }

    // The positive control: the boundaries themselves ARE storable.
    setGlobalContextGate(d, 1);
    assert.equal(resolveContextGate(d, "a"), 1);
    setGlobalContextGate(d, 100);
    assert.equal(resolveContextGate(d, "a"), 100);
  } finally {
    d.close();
  }
});

/**
 * 🛑 VALIDATION ON WRITE IS NOT ENOUGH, BECAUSE THE WRITE IS NOT THE ONLY
 * WRITER. A hand-edited database, a restored backup, or a future migration can
 * all put a number in these two places that the setters would have refused.
 *
 * ⚠️ A GUARD THAT FAILS OPEN IS WORSE THAN NO GUARD. Returning a stored 0 here
 * would schedule an immediate restart of every agent, which is exactly the
 * outcome the gate exists to control. The read falls back instead.
 */
test("🚨 a garbage value already in the database resolves to a safe number", () => {
  const d = db("a");
  try {
    d.prepare(`UPDATE agents SET context_gate = 0 WHERE handle = 'a'`).run();
    assert.equal(resolveContextGate(d, "a"), 50, "a stored 0 is not honoured");

    d.prepare(`UPDATE agents SET context_gate = 500 WHERE handle = 'a'`).run();
    assert.equal(resolveContextGate(d, "a"), 50);

    // ...and a garbage GLOBAL is skipped too, not just a garbage override.
    d.prepare(`UPDATE agents SET context_gate = NULL WHERE handle = 'a'`).run();

    // 🛑 THE NUMERIC-BUT-ILLEGAL CASES ARE THE ONES THAT MATTER, AND A
    // MUTANT PROVED IT. An earlier version of this test only stored
    // `'banana'`, which `Number()` turns into NaN — so dropping the range
    // check on the global entirely left this test GREEN while a stored `'0'`
    // was honoured and would restart every agent immediately.
    for (const bad of ["0", "-5", "500", "50.5", "banana", ""]) {
      d.prepare(
        `INSERT OR REPLACE INTO settings (key, value) VALUES ('context_gate', ?)`,
      ).run(bad);
      assert.equal(
        getGlobalContextGate(d),
        null,
        `a stored global of ${JSON.stringify(bad)} read as usable`,
      );
      assert.equal(
        resolveContextGate(d, "a"),
        50,
        `a stored global of ${JSON.stringify(bad)} was honoured`,
      );
    }

    // 🛑 THE POSITIVE CONTROL, AND IT IS NOT OPTIONAL. Every assertion above
    // expects 50, so a reader hardcoded to return 50 would pass all of them.
    // Measured: a stub that always returned the default DID pass this test
    // until this control was added. A valid stored value must be HONOURED.
    d.prepare(
      `INSERT OR REPLACE INTO settings (key, value) VALUES ('context_gate', '30')`,
    ).run();
    assert.equal(
      resolveContextGate(d, "a"),
      30,
      "control: a VALID stored global is read, so the fallback is selective",
    );
  } finally {
    d.close();
  }
});

/**
 * ⚠️ THE PRECEDENCE HAS TO HOLD WHEN THE GLOBAL IS THE GARBAGE ONE. A valid
 * override must not be dragged down to the default by a corrupt global.
 */
test("🚨 a valid override still wins over a garbage global", () => {
  const d = db("a");
  try {
    setHandleContextGate(d, "a", 30);
    d.prepare(
      `INSERT OR REPLACE INTO settings (key, value) VALUES ('context_gate', '0')`,
    ).run();

    assert.equal(resolveContextGate(d, "a"), 30);
  } finally {
    d.close();
  }
});

/**
 * 🛑 A FLOOR AND AN EFFECT, NEVER AN EQUALITY. An earlier draft of this pinned
 * `SCHEMA_VERSION === 17`, which is the same brittleness that made
 * `backlog-warned-column.test.ts` fail the moment THIS migration was added.
 * The equality belongs in `migration-content.test.ts`, which pins the count
 * once against its fingerprint list.
 */
test("🚨 the migration that adds the config ran, and is not deleted", () => {
  assert.ok(
    SCHEMA_VERSION >= 17,
    `the schema went BACKWARDS to ${SCHEMA_VERSION}; migration 17 adds settings and agents.context_gate`,
  );

  const d = db();
  try {
    const cols = (
      d.prepare(`PRAGMA table_info(agents)`).all() as unknown as {
        name: string;
      }[]
    ).map((c) => c.name);
    assert.ok(cols.includes("context_gate"), cols.join(", "));

    const tables = (
      d
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
        .all() as unknown as { name: string }[]
    ).map((t) => t.name);
    assert.ok(tables.includes("settings"), tables.join(", "));
  } finally {
    d.close();
  }
});
