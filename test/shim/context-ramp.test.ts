import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RAMP_FRACTIONS,
  rampFor,
  nextRampState,
  type RampBand,
} from "../../src/shim/context-ramp.js";
import { DEFAULT_CONTEXT_GATE } from "../../src/storage/context-gate.js";

/**
 * 🛑 THE RAMP IS RELATIVE TO THE GATE, NOT A SET OF ABSOLUTE PERCENTAGES.
 *
 * lee ruled it on 2026-11-17 — *"if the threashold is 50% then the gradients
 * should be 50% of that, 75% of that, 85% of that..."* — so a handle gated at
 * 80 gets 40/60/68 and needs no second config.
 */

test("the fractions are lee's three, ascending and strictly under the gate", () => {
  assert.deepEqual([...RAMP_FRACTIONS], [0.5, 0.75, 0.85]);

  for (const [i, f] of RAMP_FRACTIONS.entries()) {
    assert.ok(f > 0 && f < 1, `fraction ${f} is not strictly inside the gate`);
    if (i > 0)
      assert.ok(
        f > RAMP_FRACTIONS[i - 1],
        `fraction ${f} does not sit above ${RAMP_FRACTIONS[i - 1]}`,
      );
  }
});

test("the default gate resolves to the numbers recorded on the ticket", () => {
  assert.equal(DEFAULT_CONTEXT_GATE, 50);

  assert.deepEqual(
    rampFor(DEFAULT_CONTEXT_GATE).map((b) => b.at),
    [25, 37.5, 42.5],
  );
});

/**
 * ⚠️ THE TICKET'S OWN WORKED EXAMPLE. A raised per-handle gate must move the
 * whole ramp with it, which is the entire reason the shape is relative.
 */
test("a handle gated at 80 gets 40 / 60 / 68, per the ticket", () => {
  assert.deepEqual(
    rampFor(80).map((b) => b.at),
    [40, 60, 68],
  );
});

test("every band is strictly below the gate and ascending, at every legal gate", () => {
  for (let gate = 1; gate <= 100; gate++) {
    const ramp = rampFor(gate);

    for (const [i, band] of ramp.entries()) {
      assert.ok(
        band.at < gate,
        `gate ${gate}: band ${band.at} is not strictly below the gate`,
      );
      assert.ok(band.at > 0, `gate ${gate}: band ${band.at} is not positive`);
      if (i > 0)
        assert.ok(
          band.at > ramp[i - 1].at,
          `gate ${gate}: band ${band.at} does not sit above ${ramp[i - 1].at}`,
        );
    }
  }
});

/**
 * 🛑 ONE DEFINED COMPARISON, BECAUSE `percent` ARRIVES AT ONE DECIMAL.
 * `applyContextReport` computes `Math.round((used / total) * 1000) / 10`, so a
 * band carrying more precision than that can never be reached exactly.
 */
test("a band is rounded to one decimal, matching the precision of a reading", () => {
  // 75% of 3 is 2.25 and 85% of 3 is 2.55 — both need the rule to land.
  assert.deepEqual(
    rampFor(3).map((b) => b.at),
    [1.5, 2.3, 2.6],
  );

  for (let gate = 1; gate <= 100; gate++)
    for (const band of rampFor(gate))
      assert.equal(
        Math.round(band.at * 10) / 10,
        band.at,
        `gate ${gate}: band ${band.at} carries more than one decimal`,
      );
});

/**
 * 🛑 A FRESH CHILD IS NOT AT 0%. One measured container child sat at 14.4%
 * before doing any work, so a low gate puts band 1 under the starting fill and
 * it fires on turn 0, every time.
 *
 * ⚠️ 14.4 IS NOT A CONSTANT AND IS NOT HARDCODED ANYWHERE. It is the child's
 * system prompt plus its tool definitions, so a child with a different tool set
 * has a different floor. The floor is a PARAMETER, read at spawn — per claude2.
 */
test("a band at or below the starting fill is skipped, not clamped onto it", () => {
  // Gate 25 puts band 1 at 12.5, under a floor of 14.4.
  assert.deepEqual(
    rampFor(25, 14.4).map((b) => b.at),
    [18.8, 21.3],
  );

  // The boundary is inclusive: a band exactly AT the floor has already been
  // passed on turn 0, so it would fire immediately too.
  assert.deepEqual(
    rampFor(50, 25).map((b) => b.at),
    [37.5, 42.5],
  );
});

test("a floor of zero keeps every band, which is the positive control", () => {
  assert.equal(rampFor(50, 0).length, RAMP_FRACTIONS.length);
  assert.equal(rampFor(50).length, RAMP_FRACTIONS.length);
});

/**
 * ⚠️ AN EMPTY RAMP IS A LEGAL ANSWER, NOT AN ERROR. A child whose starting
 * fill already exceeds its gate has no quiet approach left; the gate still
 * fires, and that is unit 3's job, not this module's.
 */
test("a floor at or above the gate empties the ramp without throwing", () => {
  assert.deepEqual(rampFor(50, 50), []);
  assert.deepEqual(rampFor(50, 99), []);
});

/**
 * 🛑 AN ILLEGAL GATE THROWS RATHER THAN RESOLVING TO SOMETHING PLAUSIBLE.
 * `resolveContextGate` is documented never to return one, so a caller handing
 * this an illegal gate has a bug upstream and a silent ramp would hide it.
 */
test("an illegal gate throws, and names the value", () => {
  for (const bad of [0, -5, 101, 50.5, NaN, Infinity]) {
    assert.throws(
      () => rampFor(bad),
      /context ramp/i,
      `gate ${bad} did not throw`,
    );
  }

  for (const bad of [-1, NaN, Infinity]) {
    assert.throws(
      () => rampFor(50, bad),
      /context ramp/i,
      `floor ${bad} did not throw`,
    );
  }
});

const at = (ramp: RampBand[], level: number) =>
  ramp.find((b) => b.level === level)!;

/**
 * 🛑 QUIET IS THE WHOLE POINT. A notification on every reading above band 1 is
 * noise, so each band fires at most once per context lifetime. The caller
 * clears the stored level on restart, which is what makes it a lifetime.
 */
test("crossing a band fires it exactly once, however many readings follow", () => {
  const ramp = rampFor(50);
  const band1 = at(ramp, 1);

  const first = nextRampState(band1.at, ramp, null);
  assert.equal(first.fire?.level, 1);
  assert.equal(first.next_level, 1);

  for (const pct of [band1.at, band1.at + 0.1, 30, 35]) {
    const again = nextRampState(pct, ramp, first.next_level);
    assert.equal(again.fire, null, `${pct} re-fired band 1`);
    assert.equal(again.next_level, 1, `${pct} moved the stored level`);
  }
});

/**
 * 🛑 NO HYSTERESIS, DELIBERATELY, AND THAT IS THE OPPOSITE OF `gauge.ts`.
 * The gauge downshifts so a peer who compacted is warned again. Here a drop in
 * fill means the agent did the hygiene the ramp was asking for, so re-arming
 * the band would warn them for succeeding.
 */
test("a fill that drops back does not re-arm the band", () => {
  const ramp = rampFor(50);

  const t = nextRampState(1, ramp, 2);

  assert.equal(t.fire, null);
  assert.equal(t.next_level, 2, "a drop in fill un-latched the stored level");
});

test("a jump past several bands fires only the loudest crossed", () => {
  const ramp = rampFor(50);

  const t = nextRampState(at(ramp, 3).at, ramp, null);

  assert.equal(t.fire?.level, 3);
  assert.equal(t.next_level, 3);
});

test("a reading below the first band fires nothing and stores nothing", () => {
  const ramp = rampFor(50);

  const t = nextRampState(at(ramp, 1).at - 0.1, ramp, null);

  assert.equal(t.fire, null);
  assert.equal(t.next_level, null);
});

/**
 * ⚠️ THE GATE IS NOT A RAMP BAND. This module answers only the quiet approach;
 * the notice, the countdown and the restart are unit 3. A ramp that fired at
 * 100% of the gate would make two owners for one event.
 */
test("a reading at or past the gate is still only the top band", () => {
  const ramp = rampFor(50);

  for (const pct of [50, 75, 100]) {
    const t = nextRampState(pct, ramp, null);
    assert.equal(t.fire?.level, 3, `${pct} did not stop at the top band`);
  }
});

test("an empty ramp fires nothing at any reading", () => {
  for (const pct of [0, 25, 50, 100]) {
    const t = nextRampState(pct, [], null);

    assert.equal(t.fire, null, `${pct} fired on an empty ramp`);
    assert.equal(t.next_level, null);
  }
});
