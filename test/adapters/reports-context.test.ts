import { test } from "node:test";
import assert from "node:assert/strict";
import { reportsContextFor, spawnFor } from "../../src/adapters/index.js";

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

/**
 * 🛑 `false` MUST SURVIVE, AND `?? null` IS WHAT MAKES THAT TRUE. A `||` here
 * would turn cursor's deliberate `false` into `null`, and `null` renders the
 * older blank — so the one vendor this ticket exists for would show nothing.
 */
test("🛑 a vendor that reports FALSE answers false, never null", () => {
  assert.equal(reportsContextFor("cursor"), false);
});

test("a vendor that reports a window answers true", () => {
  assert.equal(reportsContextFor("claude"), true);
});

/**
 * 🛑 ONE HOME. A second copy of this answer in `server.ts` or the browser is
 * free to drift from the adapter that declares it, and the adapter is the only
 * place that measured the CLI.
 */
test("🛑 the answer comes from the adapter's own declaration", () => {
  for (const vendor of ["claude", "cursor"]) {
    assert.equal(
      reportsContextFor(vendor),
      spawnFor(vendor).reportsContext,
      `${vendor} disagrees with its own spawn contract`,
    );
  }
});
