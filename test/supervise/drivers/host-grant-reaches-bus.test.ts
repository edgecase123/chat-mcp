import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChildGrant } from "../../../src/supervise/grant.js";
import { assertHostGrantReachesBus } from "../../../src/supervise/drivers/wiring.js";
import { spawnOnHost } from "../../../src/supervise/drivers/host.js";
import { spawnFor, vendorsWithSpawn } from "../../../src/adapters/index.js";

/**
 * 🛑 A POSITIVE DECLARATION, NOT AN INFERENCE FROM THE ARGV. Argv identity
 * between a granted and an ungranted child says "this grant changes nothing
 * about what is exec'd" — true for Cursor on the host today, and STILL true
 * once a host grant is delivered by writing `.cursor/mcp.json`, which changes
 * no argv. So an argv-derived guard would refuse a route that works.
 *
 * 🛑 AND `mcpConfigFlags` CANNOT BE THE SIGNAL EITHER. It has ONE call site in
 * `src/`, inside `containerized.ts`, so the host path never reads it — and
 * Cursor in DOCKER returns `[]` from it while reaching the bus through a
 * written file. Both inferences were proposed and both were measured wrong.
 */

const GRANT: ChildGrant = {
  handle: "h-child",
  configPath: "/tmp/does-not-need-to-exist.json",
  allowed: [],
  available: [],
  extraDirs: [],
};

test("🔴 a GRANTED host child whose vendor delivers the grant NOWHERE is refused", () => {
  assert.throws(
    () =>
      assertHostGrantReachesBus(
        { vendor: "delivers-nothing", hostGrantDelivery: "none" },
        GRANT,
      ),
    /delivers-nothing/,
  );
});

test("the refusal says the agent would ANSWER NOTHING and names the ungranted way out", () => {
  assert.throws(
    () =>
      assertHostGrantReachesBus(
        { vendor: "delivers-nothing", hostGrantDelivery: "none" },
        GRANT,
      ),
    (e) => {
      const message = (e as Error).message;

      assert.match(message, /answer nothing/i);
      assert.match(message, /ungranted/i);

      return true;
    },
  );
});

test("🔴 control — a vendor delivering by FLAGS is allowed", () => {
  assert.doesNotThrow(() =>
    assertHostGrantReachesBus(
      { vendor: "by-flags", hostGrantDelivery: "flags" },
      GRANT,
    ),
  );
});

/**
 * 🛑 `"file"` IS ALLOWED BEFORE ANY VENDOR DECLARES IT, ON PURPOSE. This is
 * the value a host-wired Cursor takes, and a guard that only knew `"flags"`
 * would have to be edited in the same change that wires it — which is how a
 * refusal outlives the thing it was protecting against.
 */
test("🔴 control — a vendor delivering by FILE is allowed", () => {
  assert.doesNotThrow(() =>
    assertHostGrantReachesBus(
      { vendor: "by-file", hostGrantDelivery: "file" },
      GRANT,
    ),
  );
});

/**
 * 🛑 #348's OWN DOCUMENTED WORKAROUND. An ungranted Cursor child is a working
 * configuration: it reaches no bus because it was never promised one. A
 * blanket refusal of the vendor would take that away.
 */
test("🔴 control — an UNGRANTED child is allowed whatever its vendor declares", () => {
  assert.doesNotThrow(() =>
    assertHostGrantReachesBus(
      { vendor: "delivers-nothing", hostGrantDelivery: "none" },
      undefined,
    ),
  );
});

test("🛑 the REAL cursor vendor is refused and the REAL claude vendor is not", () => {
  assert.throws(
    () => assertHostGrantReachesBus(spawnFor("cursor"), GRANT),
    /cursor/,
  );
  assert.doesNotThrow(() =>
    assertHostGrantReachesBus(spawnFor("claude"), GRANT),
  );
});

/**
 * 🛑 THE DECLARATION IS PINNED TO THE ARGV, WHICH IS WHAT STOPS IT BEING A
 * COMMENT. A vendor could declare `"flags"` and ignore the grant entirely, and
 * nothing else in the suite would notice — the refusal would simply never
 * fire for it. This is the cross-check, and it is the reason the field is a
 * declaration rather than a second opinion.
 */
test("🛑 a vendor declaring FLAGS really does change its host argv for a grant", () => {
  let checked = 0;

  for (const name of vendorsWithSpawn()) {
    const spawn = spawnFor(name);

    if (spawn.hostGrantDelivery !== "flags") continue;

    checked += 1;
    assert.notDeepEqual(
      spawn.argsFor({ grant: GRANT }, "host"),
      spawn.argsFor({}, "host"),
      `vendor "${name}" declares hostGrantDelivery "flags" and its host argv ignores the grant`,
    );
  }

  // 🛑 THE DENOMINATOR, BECAUSE A `continue` LOOP IS GREEN ON ZERO ROWS.
  // Rename the value and every assertion above is skipped rather than failed.
  assert.ok(checked > 0, 'no vendor declares hostGrantDelivery "flags"');
});

test("🛑 a vendor declaring NONE really does ignore the grant in its host argv", () => {
  let checked = 0;

  for (const name of vendorsWithSpawn()) {
    const spawn = spawnFor(name);

    if (spawn.hostGrantDelivery !== "none") continue;

    checked += 1;
    assert.deepEqual(
      spawn.argsFor({ grant: GRANT }, "host"),
      spawn.argsFor({}, "host"),
      `vendor "${name}" declares hostGrantDelivery "none" and its host argv names the grant anyway`,
    );
  }

  // 🛑 SAME DENOMINATOR. This one goes to ZERO the moment slice 2 moves
  // Cursor to `"file"`, and that is the signal to retire this test rather than
  // let it keep reporting green over nothing.
  assert.ok(checked > 0, 'no vendor declares hostGrantDelivery "none"');
});

/**
 * The guard is wired into the spawn, not merely exported.
 *
 * 🛑 THE THROWING CASE IS THE ONLY ONE THAT SPAWNS NOTHING. An allowed case
 * would exec a real CLI and block on a stdin no test closes, so the allowed
 * cases are covered against the assertion above instead.
 */
test("🛑 spawnOnHost REFUSES a granted cursor child before it spawns anything", () => {
  assert.throws(
    () => spawnOnHost(spawnFor("cursor"), { grant: GRANT }),
    /cursor/,
  );
});
