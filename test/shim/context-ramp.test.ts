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
  assert.equal(first.next_mark, band1.at);

  for (const pct of [band1.at, band1.at + 0.1, 30, 35]) {
    const again = nextRampState(pct, ramp, first.next_mark);
    assert.equal(again.fire, null, `${pct} re-fired band 1`);
    assert.equal(again.next_mark, band1.at, `${pct} moved the stored mark`);
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

  const t = nextRampState(1, ramp, at(ramp, 2).at);

  assert.equal(t.fire, null);
  assert.equal(
    t.next_mark,
    at(ramp, 2).at,
    "a drop in fill un-latched the stored mark",
  );
});

test("a jump past several bands fires only the loudest crossed", () => {
  const ramp = rampFor(50);

  const t = nextRampState(at(ramp, 3).at, ramp, null);

  assert.equal(t.fire?.level, 3);
  assert.equal(t.next_mark, at(ramp, 3).at);
});

test("a reading below the first band fires nothing and stores nothing", () => {
  const ramp = rampFor(50);

  const t = nextRampState(at(ramp, 1).at - 0.1, ramp, null);

  assert.equal(t.fire, null);
  assert.equal(t.next_mark, null);
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
    assert.equal(t.next_mark, null);
  }
});

/**
 * 🛑 THE LATCH IS A PERCENT, NOT A BAND INDEX, AND THAT IS WHY A RAISED GATE
 * STILL WARNS. A stored index means "band 3 has fired", which is a claim about
 * a ramp that no longer exists once the gate moves — so the agent is latched at
 * the top of its old ramp and never warned again. Raised by claude2 on PR 309.
 *
 * ⚠️ MY FIRST REASON FOR THE LATCH ANSWERED A DIFFERENT EVENT. "A drop in fill
 * means the agent did the hygiene" is about the DROP. This is about the CLIMB
 * after it, under a ramp that moved. Declining the first does not decline this.
 */
test("raising the gate re-arms every band above the stored mark", () => {
  // Gate 50, the agent reached 43, so band 3 at 42.5 fired and 42.5 is stored.
  const fired = nextRampState(43, rampFor(50), null);
  assert.equal(fired.next_mark, 42.5);

  // The gate is raised to 100, which moves the whole ramp to 50 / 75 / 85.
  const raised = rampFor(100);
  assert.deepEqual(
    raised.map((b) => b.at),
    [50, 75, 85],
  );

  const climbing = nextRampState(60, raised, fired.next_mark);
  assert.equal(climbing.fire?.at, 50, "the raised ramp never warned again");
  assert.equal(climbing.next_mark, 50);

  const higher = nextRampState(85, raised, climbing.next_mark);
  assert.equal(higher.fire?.at, 85);
});

/**
 * ⚠️ THE POSITIVE CONTROL FOR THE TEST ABOVE. A mark must still SUPPRESS the
 * bands it has already passed, or re-arming on a gate change would just be a
 * ramp that re-fires everything on every reading.
 */
test("lowering the gate does not re-fire a band at or below the stored mark", () => {
  // Stored 42.5 from a gate of 50. Lowered to 40, the ramp is 20 / 30 / 34.
  const lowered = rampFor(40);
  assert.deepEqual(
    lowered.map((b) => b.at),
    [20, 30, 34],
  );

  const t = nextRampState(39, lowered, 42.5);

  assert.equal(t.fire, null, "a lowered gate re-fired a band already passed");
  assert.equal(t.next_mark, 42.5);
});

/**
 * 🛑 THE STORED MARK IS THE ONE LAYER THAT COMES FROM THE DATABASE, SO IT IS
 * VALIDATED ON READ. `context-gate.ts` makes the same argument for the gate: a
 * hand edit, a restored backup and a future migration all reach the same row.
 *
 * 🛑 AN UNUSABLE MARK MEANS "NOTHING HAS FIRED", NOT "EVERYTHING HAS". A
 * stored 999 would otherwise kill the ramp for that handle permanently, and a
 * lost warning is the failure this ticket exists to fix. The next fire writes
 * a usable value back, so it is self-correcting.
 *
 * ⚠️ IT DOES NOT THROW, AND THE GATE DOES. The gate arrives from code that
 * guarantees it; this arrives from a row anything can write.
 */
test("an unusable stored mark is read as nothing-fired, not as everything-fired", () => {
  const ramp = rampFor(50);

  for (const bad of [-1, 101, NaN, Infinity, -Infinity]) {
    const t = nextRampState(43, ramp, bad);

    assert.equal(t.fire?.level, 3, `a stored ${bad} killed the ramp`);
    assert.equal(t.next_mark, 42.5, `a stored ${bad} was written back`);
  }
});

test("a usable stored mark is HONOURED, which is the control for the one above", () => {
  const ramp = rampFor(50);

  for (const good of [0, 25, 37.5, 42.5, 100]) {
    const t = nextRampState(43, ramp, good);

    if (good >= 42.5) {
      assert.equal(t.fire, null, `a stored ${good} was ignored`);
      assert.equal(t.next_mark, good);
    } else {
      assert.equal(t.fire?.level, 3, `a stored ${good} suppressed too much`);
    }
  }
});

/**
 * 🛑 THE CONTROL THAT MAKES THE VALIDATION NON-VACUOUS. Every unusable mark
 * behaves like `null` on a reading that FIRES, so the firing test alone cannot
 * tell the guard from its absence — a stored -1 fires band 3 either way.
 *
 * The difference is only visible on a reading that fires NOTHING: validated,
 * the junk is cleared and the row self-cleans; unvalidated, it is written
 * straight back and kept forever. Found by mutating `mark >= 0` away and
 * watching all 19 tests stay green.
 */
test("an unusable stored mark is CLEARED by a reading that fires nothing", () => {
  const ramp = rampFor(50);
  const belowBandOne = at(ramp, 1).at - 0.1;

  for (const bad of [-1, 101, NaN, Infinity, -Infinity]) {
    const t = nextRampState(belowBandOne, ramp, bad);

    assert.equal(t.fire, null, `a stored ${bad} fired below band 1`);
    assert.equal(t.next_mark, null, `a stored ${bad} was carried, not cleared`);
  }
});

test("a usable mark is CARRIED by a reading that fires nothing", () => {
  const ramp = rampFor(50);

  const t = nextRampState(at(ramp, 1).at - 0.1, ramp, 42.5);

  assert.equal(t.fire, null);
  assert.equal(t.next_mark, 42.5, "a usable mark was cleared");
});
