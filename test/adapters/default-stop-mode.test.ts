import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defaultStopModeFor,
  spawnFor,
  vendorsWithSpawn,
} from "../../src/adapters/index.js";

/**
 * #415 — which stop mode an operator gets when they name none.
 *
 * `graceful` was a constant, chosen on 2026-10-31 because a turn cut
 * mid-stream spends its tokens for nothing. A vendor that runs one process per
 * turn inverts that: with no turn live, graceful is the only mode that spends
 * anything at all. lee ruled `now` for those vendors on 2026-11-24.
 */

test("🛑 an UNKNOWN vendor answers graceful, it does NOT throw", () => {
  // The control: the throwing sibling, on the same input. Without it this file
  // passes for a build where nothing throws, and the reason a second
  // non-throwing function exists goes unmeasured.
  assert.throws(() => spawnFor("nope-not-a-vendor"));

  assert.equal(defaultStopModeFor("nope-not-a-vendor"), "graceful");
  assert.equal(defaultStopModeFor(""), "graceful");
});

/**
 * 🛑 THE TWO SHIPPED VENDORS DISAGREE, WHICH IS WHAT MAKES THIS FILE ABLE TO
 * FAIL. `reportsContextFor`'s own test records that both its vendors answer
 * `true`, leaving it unable to tell a real lookup from a constant. Here cursor
 * declares `processPerTurn: true` and claude declares `false`, so a function
 * returning either constant reds one of these two rows.
 */
test("a per-turn vendor defaults to now, and a continuous one to graceful", () => {
  assert.equal(defaultStopModeFor("cursor"), "now");
  assert.equal(defaultStopModeFor("claude"), "graceful");
});

/**
 * 🛑 ONE HOME. The answer is derived from the adapter that declares
 * `processPerTurn`, never from a list of vendor names kept somewhere else.
 *
 * 🛑 EVERY VENDOR, NOT THE SHIPPED PAIR. A hardcoded pair silently stops
 * covering the third vendor on the day it lands.
 */
test("🛑 the answer is derived from the vendor's own processPerTurn", () => {
  const vendors = vendorsWithSpawn();

  assert.ok(vendors.length > 0, "the control: the registry is not empty");

  for (const vendor of vendors) {
    assert.equal(
      defaultStopModeFor(vendor),
      spawnFor(vendor).processPerTurn ? "now" : "graceful",
      `${vendor} disagrees with its own spawn contract`,
    );
  }
});
