import { test } from "node:test";
import assert from "node:assert/strict";
import { contextPercent } from "../../src/shim/gauge-report.js";
import { rampFor } from "../../src/shim/context-ramp.js";
import { gaugeDisplay } from "../../web/assets/logic.js";

/**
 * 🛑 THE COLOUR AND THE RESTART MUST BAND ON THE SAME NUMBER.
 *
 * `contextPercent` rounds to one decimal and the supervisor's restart compares
 * that. The first cut of the gauge compared the RAW fill, so the two disagreed
 * on the tick itself — a reading could fire band 1 in the supervisor while the
 * gauge stayed default, which is the exact "looked calm until it died" failure
 * #135 exists to end.
 *
 * ⚠️ EVERY CASE BELOW CARRIES ITS OWN NON-VACUITY CHECK. A case whose raw fill
 * is already past the tick passes under full precision too, so it would prove
 * nothing. `raw` is asserted to sit on the far side of `tick` before the band
 * is read.
 */

/** Where the raw fill and the one-decimal fill fall on opposite sides of a tick. */
const DIVERGENT = [
  { gate: 50, used: 49920, total: 200000, tick: 25, band: "ramp1" },
  { gate: 50, used: 74900, total: 200000, tick: 37.5, band: "ramp2" },
  { gate: 80, used: 119900, total: 200000, tick: 60, band: "ramp2" },
];

function peer(used: number, total: number, gate: number) {
  return {
    context_used: used,
    context_total: total,
    fresh: true,
    age_ms: 0,
    context_ramp: rampFor(gate).map((b) => b.at),
  };
}

test("🛑 a fill that fires the supervisor's band also colours the gauge", () => {
  for (const c of DIVERGENT) {
    const raw = (c.used / c.total) * 100;
    const tenths = contextPercent(c.used, c.total);

    // The case's own premise. Without these two the case is vacuous.
    assert.ok(
      raw < c.tick,
      `vacuous case — raw ${raw} is already past the ${c.tick} tick`,
    );
    assert.ok(
      tenths >= c.tick,
      `vacuous case — contextPercent ${tenths} does not reach ${c.tick}`,
    );

    assert.equal(
      gaugeDisplay(peer(c.used, c.total, c.gate)).band,
      c.band,
      `${c.used}/${c.total} at gate ${c.gate}: supervisor is at ${tenths}, gauge disagreed`,
    );
  }
});

/**
 * ⚠️ THE PAIRED CONTROL. Without it, banding on a number rounded far enough UP
 * would pass the test above — the fix could overshoot into colouring a fill the
 * supervisor has not banded either.
 */
test("⚠️ control — a fill the supervisor has NOT banded stays default", () => {
  for (const c of DIVERGENT) {
    // One tenth of a point below the tick, which the supervisor reads as below.
    const used = Math.round(((c.tick - 0.1) / 100) * c.total);
    const tenths = contextPercent(used, c.total);

    assert.ok(tenths < c.tick, `premise — ${tenths} should be under ${c.tick}`);

    const band = gaugeDisplay(peer(used, c.total, c.gate)).band;

    assert.notEqual(
      band,
      c.band,
      `${used}/${c.total} is ${tenths}, under the ${c.tick} tick, yet coloured ${band}`,
    );
  }
});

/**
 * 🛑 THE LABEL KEEPS ITS OWN ROUNDING, AND DERIVING IT FROM THE BAND'S NUMBER
 * WOULD MOVE IT. 24.45 is 24.5 at one decimal and 25 after a second round,
 * where the raw fill rounds to 24.
 */
test("🛑 the integer label is not a second rounding of the band's number", () => {
  const g = gaugeDisplay(peer(48900, 200000, 50));

  assert.equal(contextPercent(48900, 200000), 24.5);
  assert.equal(g.percent, 24, "the label double-rounded through one decimal");
});
