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

/**
 * 🛑 NO REAL VENDOR IS REFUSED ANY MORE, AND THAT IS SLICE 2 LANDING. Cursor
 * was the only one, on `"none"`, and its host grant is now delivered by
 * writing `.cursor/mcp.json`. The refusal is kept for the NEXT vendor, which
 * is why the fake-vendor cases above are the ones that exercise it.
 *
 * ⚠️ THIS IS NOT "the guard is now unreachable". `spawnOnHost` still calls it
 * first, and `host-grant-file.test.ts` asserts the delivery it was guarding
 * actually lands — a declaration alone would make this test pass while the
 * agent answered nothing.
 */
test("🛑 NEITHER real vendor is refused, and each declares HOW it delivers", () => {
  for (const name of ["cursor", "claude"] as const) {
    assert.doesNotThrow(
      () => assertHostGrantReachesBus(spawnFor(name), GRANT),
      `vendor "${name}" is refused a host grant`,
    );
    assert.notEqual(
      spawnFor(name).hostGrantDelivery,
      "none",
      `vendor "${name}" passed the guard while declaring "none", which is impossible`,
    );
  }
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

/**
 * 🛑 REPLACES THE `"none"` LOOP, WHICH SLICE 2 TOOK TO ZERO ROWS. Its own note
 * said to retire it rather than let a `continue` loop report green over
 * nothing, and Cursor was its only row.
 *
 * 🛑 THIS IS THE CROSS-CHECK THAT `"file"` IS NOT `"flags"` MISSPELLED. A
 * file-delivered grant changes NO argv — that is the whole reason the field is
 * a declaration and not an inference — so a vendor declaring `"file"` whose
 * argv moves for a grant has one of the two wrong.
 */
test("🛑 a vendor declaring FILE leaves its host argv UNCHANGED by the grant", () => {
  let checked = 0;

  for (const name of vendorsWithSpawn()) {
    const spawn = spawnFor(name);

    if (spawn.hostGrantDelivery !== "file") continue;

    checked += 1;
    assert.deepEqual(
      spawn.argsFor({ grant: GRANT }, "host"),
      spawn.argsFor({}, "host"),
      `vendor "${name}" declares hostGrantDelivery "file" and its host argv moves for a grant, ` +
        `so it is really delivering by flags`,
    );
  }

  assert.ok(checked > 0, 'no vendor declares hostGrantDelivery "file"');
});

/**
 * The guard is wired into the spawn, not merely exported.
 *
 * 🛑 THE THROWING CASE IS THE ONLY ONE THAT SPAWNS NOTHING. An allowed case
 * would exec a real CLI and block on a stdin no test closes, so the allowed
 * cases are covered against the assertion above instead.
 */
test("🛑 spawnOnHost REFUSES a granted child whose vendor delivers NOWHERE", () => {
  // The two fields reached before the guard, and nothing else. A full vendor
  // would be a fake of the thing under test.
  const deliversNothing = {
    vendor: "delivers-nothing",
    hostGrantDelivery: "none",
    processPerTurn: true,
  } as unknown as Parameters<typeof spawnOnHost>[0];

  assert.throws(
    () => spawnOnHost(deliversNothing, { grant: GRANT }),
    /delivers-nothing/,
  );
});
