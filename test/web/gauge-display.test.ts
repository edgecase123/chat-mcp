import { test } from "node:test";
import assert from "node:assert/strict";
import { gaugeDisplay, ageLabel } from "../../web/assets/logic.js";

/**
 * #103 — both agents sat at exactly 1000000/1000000 with a 27.7-day-old
 * timestamp and every reader took it as current.
 */

test("a fresh reading shows a percent and its band", () => {
  const g = gaugeDisplay({
    context_used: 766561,
    context_total: 1000000,
    fresh: true,
    context_ramp: [25, 37.5, 42.5],
  });

  assert.equal(g.show, true);
  assert.equal(g.percent, 77);
  assert.equal(g.band, "ramp3");
});

/**
 * 🛑 THE WHOLE POINT. A stale reading must not render its last number —
 * greyed digits are still digits, and digits are what get acted on.
 */
test("a stale reading shows NO percent, however full it claimed to be", () => {
  const g = gaugeDisplay({
    context_used: 1000000,
    context_total: 1000000,
    fresh: false,
    age_ms: 2396552000,
  });

  assert.equal(g.percent, null, "the stale number leaked through");
  assert.equal(g.band, "stale");
  assert.match(g.title, /27d old/);
});

test("never reported shows nothing at all", () => {
  assert.equal(gaugeDisplay({}).show, false);
  assert.equal(
    gaugeDisplay({ context_used: 5, context_total: null }).show,
    false,
  );
});

/** A zero total would divide by zero and render Infinity%. */
test("a zero total is treated as unreported", () => {
  assert.equal(
    gaugeDisplay({ context_used: 5, context_total: 0, fresh: true }).show,
    false,
  );
});

/**
 * 🛑 THE COLOUR BANDS ARE THE GATE'S RAMP, NOT THE BUS'S ABSOLUTE BANDS. The
 * old set was a hardcoded 70/85/95, and a handle gated at 50 is restarted
 * before it can reach 70 — so two of the three could never render and the
 * third was the restart itself. lee ruled the colours on 2026-11-18.
 *
 * ⚠️ THE TICKS ARRIVE FROM THE SERVER AND ARE NOT DERIVED HERE. `rampFor` in
 * `src/shim/context-ramp.ts` owns lee's fractions, and a second copy of them
 * in the browser would be free to drift from the ones the restart uses.
 */
const at = (percent: number, ramp: number[]) =>
  gaugeDisplay({
    context_used: percent,
    context_total: 100,
    fresh: true,
    context_ramp: ramp,
  }).band;

test("🛑 the bands are the ramp of the handle's OWN gate", () => {
  const gate50 = [25, 37.5, 42.5];

  assert.equal(at(24, gate50), "ok");
  assert.equal(at(25, gate50), "ramp1");
  assert.equal(at(37, gate50), "ramp1");
  assert.equal(at(37.5, gate50), "ramp2");
  assert.equal(at(42, gate50), "ramp2");
  assert.equal(at(42.5, gate50), "ramp3");
});

test("🛑 a RAISED gate moves the whole ramp, which is the point of the override", () => {
  // 40 colours band 1 at a gate of 80 and nothing at all at a gate of 50's
  // ramp, where it sits above every tick. One number, two answers.
  const gate80 = [40, 60, 68];

  assert.equal(at(39, gate80), "ok");
  assert.equal(at(40, gate80), "ramp1");
  assert.equal(at(60, gate80), "ramp2");
  assert.equal(at(68, gate80), "ramp3");
  assert.equal(at(40, [25, 37.5, 42.5]), "ramp2");
});

/**
 * 🛑 lee RULED "A-STATELESS" ON 2026-11-18, against a hysteresis reading of
 * "up to reset threshold". `gauge.ts` BANDS carry a reset 5 points under each
 * warn, and the colour deliberately does NOT.
 *
 * Hysteresis exists to stop NOTIFICATION chatter. A colour has no chatter
 * cost, and this function is pure with nowhere to keep a latch.
 */
test("🛑 the colour steps back DOWN the instant the fill does — no hysteresis", () => {
  const gate50 = [25, 37.5, 42.5];

  assert.equal(at(44, gate50), "ramp3");
  assert.equal(at(42.4, gate50), "ramp2", "a reset threshold leaked in");
  assert.equal(at(37.4, gate50), "ramp1");
  assert.equal(at(24.9, gate50), "ok");
});

test("🛑 the GATE itself is not a fourth colour — the restart owns that event", () => {
  const gate50 = [25, 37.5, 42.5];

  assert.equal(at(50, gate50), "ramp3");
  assert.equal(at(100, gate50), "ramp3");
});

/**
 * 🛑 THE DISPLAYED PERCENT IS ROUNDED AND THE BANDING IS NOT. A tick sits at
 * one decimal, so banding on the rounded integer would colour a reading 0.4
 * points before it crossed. The digits and the colour may disagree, and the
 * colour is the one that must be right.
 */
test("🛑 banding reads the EXACT fill, while the label reads the rounded one", () => {
  const g = gaugeDisplay({
    context_used: 24.6,
    context_total: 100,
    fresh: true,
    context_ramp: [25, 37.5, 42.5],
  });

  assert.equal(g.percent, 25, "the label should round as it always has");
  assert.equal(g.band, "ok", "24.6 is below the tick and must not colour");
});

/**
 * ⚠️ FAILING QUIET IS DELIBERATE HERE AND IS GUARDED ELSEWHERE. Without a gate
 * there is no tick to compare, and inventing one would put a second home for
 * lee's default beside `DEFAULT_CONTEXT_GATE`.
 *
 * 🛑 SO THE REAL GUARD IS THAT THE PAYLOAD ALWAYS CARRIES ONE — asserted in
 * `test/web/whoami-ramp.test.ts`, not here. A quiet fallback with no guard
 * upstream would be a guard that fails open.
 */
test("a peer with no ramp shows its number and no colour", () => {
  const g = gaugeDisplay({
    context_used: 90,
    context_total: 100,
    fresh: true,
  });

  assert.equal(g.show, true);
  assert.equal(g.percent, 90);
  assert.equal(g.band, "ok");
});

test("a stale reading beats the ramp, however full it claimed to be", () => {
  // The #103 rule outranks the colour: a dash has no band to colour.
  const g = gaugeDisplay({
    context_used: 99,
    context_total: 100,
    fresh: false,
    age_ms: 60 * 60 * 1000,
    context_ramp: [25, 37.5, 42.5],
  });

  assert.equal(g.band, "stale");
  assert.equal(g.percent, null);
});

test("age reads at a glance and never as raw milliseconds", () => {
  assert.equal(ageLabel(null), "never reported");
  assert.equal(ageLabel(59 * 60 * 1000), "59m");
  assert.equal(ageLabel(3 * 60 * 60 * 1000), "3h");
  assert.equal(ageLabel(5 * 24 * 60 * 60 * 1000), "5d");
});

/**
 * #371 — a blank gauge had two causes and the operator needed opposite
 * responses to them. A vendor that reports no window will never fill it in;
 * a vendor that does has simply not reported yet.
 */
test("🛑 a vendor that reports NO window says so, instead of rendering nothing", () => {
  const g = gaugeDisplay({ reports_context: false });

  assert.equal(g.show, true, "the chip was dropped, so nothing says why");
  assert.equal(g.percent, null);
  assert.equal(g.band, "unreported");
  assert.match(g.title, /no percentage is possible/);
});

/**
 * 🛑 THE TWO STATES THIS CHANGE EXISTS TO SEPARATE. Both carry a null percent,
 * so the BAND is the only thing a chip can style or a reader can tell apart —
 * and a shared band would put them back under one glyph.
 */
test("🛑 unreported and STALE are different bands, not one null percent", () => {
  const unreported = gaugeDisplay({ reports_context: false });
  const stale = gaugeDisplay({
    context_used: 10,
    context_total: 100,
    fresh: false,
    age_ms: 60 * 60 * 1000,
  });

  assert.equal(unreported.percent, null);
  assert.equal(stale.percent, null);
  assert.notEqual(unreported.band, stale.band);
});

/**
 * 🛑 `null` IS NOT `false`. An unregistered handle's vendor is unknown, and
 * labelling it "n/a" would be a confident claim about the one case we cannot
 * see.
 */
test("🛑 an UNKNOWN vendor keeps the older blank, never the n/a label", () => {
  for (const reports_context of [null, undefined]) {
    const g = gaugeDisplay({ reports_context });

    assert.equal(g.show, false, `reports_context=${reports_context} rendered`);
    assert.equal(g.band, "none");
  }
});

/**
 * ⚠️ THE SPLIT SITS INSIDE `!reported`, SO A REPORTING AGENT IS UNTOUCHED BY
 * ITS REGISTRATION. An operator who registers the wrong vendor mislabels the
 * WAIT and nothing else.
 */
test("🛑 a real reading beats reports_context: false", () => {
  const g = gaugeDisplay({
    context_used: 50,
    context_total: 100,
    fresh: true,
    reports_context: false,
  });

  assert.equal(g.percent, 50);
  assert.equal(g.band, "ok");
});
