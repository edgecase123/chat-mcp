import { test } from "node:test";
import assert from "node:assert/strict";
import {
  reportsContextFor,
  spawnFor,
  vendorsWithSpawn,
} from "../../src/adapters/index.js";

/**
 * #371 — the web card needs to say WHY a gauge is blank, and the question
 * reaches the registry with a vendor string out of `agents.json`. That file is
 * operator-edited and `registerAgent` deliberately does not check spawnability,
 * so an unknown vendor is the workflow rather than an anomaly.
 */

test("🛑 an UNKNOWN vendor answers null, it does NOT throw", () => {
  // The control: the throwing sibling, on the same input. Without this the
  // assertion below passes for a build where nothing throws at all, and the
  // whole reason this function exists goes unmeasured.
  assert.throws(() => spawnFor("nope-not-a-vendor"));

  assert.equal(reportsContextFor("nope-not-a-vendor"), null);
  assert.equal(reportsContextFor(""), null);
});

test("every shipped vendor that reports a window answers true", () => {
  assert.equal(reportsContextFor("claude"), true);
  assert.equal(reportsContextFor("cursor"), true);
});

/**
 * 🛑 ONE HOME. A second copy of this answer in `server.ts` or the browser is
 * free to drift from the adapter that declares it, and the adapter is the only
 * place that measured the CLI.
 *
 * 🛑 EVERY VENDOR, NOT A HARDCODED PAIR. The pair was `["claude", "cursor"]`,
 * which is the whole registry today and silently stops covering the third
 * vendor the day it lands.
 *
 * ⚠️ THIS IS ALSO THE ONLY THING LEFT GUARDING `?? null` AGAINST `|| null`,
 * AND IT CANNOT FIRE TODAY. Those two differ only on a `false` declaration,
 * and since #419 made cursor report a window NO SHIPPED VENDOR DECLARES
 * `false`. The test that used to exercise it asserted cursor's `false`
 * directly. It is deleted rather than flipped, because flipping it to `true`
 * would have left a test named for a branch it no longer reaches. **The guard
 * is unexercised until a vendor declares `false` again**, at which point this
 * loop catches it with no edit.
 */
test("🛑 the answer comes from the adapter's own declaration", () => {
  const vendors = vendorsWithSpawn();

  assert.ok(vendors.length > 0, "the control: the registry is not empty");

  for (const vendor of vendors) {
    assert.equal(
      reportsContextFor(vendor),
      spawnFor(vendor).reportsContext,
      `${vendor} disagrees with its own spawn contract`,
    );
  }
});
