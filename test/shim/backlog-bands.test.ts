import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BANDS,
  nextBacklogState,
  backlogDeliveryFor,
  warningBody,
  type Threshold,
} from "../../src/shim/backlog.js";

/**
 * 🛑 THE AXIS IS AGE, NOT DEPTH, AND THAT WAS MEASURED BEFORE IT WAS RULED.
 *
 * Over 26 days of `chat.db`, no live agent ever held more than 6 unread DMs,
 * so no depth band both fires on a real incident and stays quiet on routine
 * traffic. DM wait time splits cleanly instead — p50 0.2 min, p95 407 min.
 * lee ruled "OK, age" on that measurement.
 */

test("the bands are ascending minutes, as a property rather than a list", () => {
  assert.ok(
    BANDS.length >= 4,
    `expected at least 4 bands, found ${BANDS.length}`,
  );

  for (const [i, band] of BANDS.entries()) {
    assert.ok(
      band.warn > 0,
      `band ${band.warn} is not a positive minute count`,
    );
    if (i > 0)
      assert.ok(
        band.warn > BANDS[i - 1].warn,
        `band ${band.warn} does not sit above ${BANDS[i - 1].warn}`,
      );
  }
});

/**
 * 🛑 NOTHING UNREAD IS NOT A ZERO-MINUTE BACKLOG. `null` is the absence of a
 * backlog and must clear the stored band, or an agent that caught up stays
 * latched at whatever it last fired and never fires again.
 */
test("nothing unread clears the stored band and fires nothing", () => {
  for (const prev of [null, 5, 15, 60, 240] as (Threshold | null)[]) {
    const t = nextBacklogState(null, prev);

    assert.equal(t.next_warned, null, `prev ${prev} did not clear`);
    assert.equal(t.fire, null, `prev ${prev} fired on an empty backlog`);
  }
});

test("a fresh backlog below the first band fires nothing", () => {
  const t = nextBacklogState(BANDS[0].warn - 0.1, null);

  assert.equal(t.fire, null);
  assert.equal(t.next_warned, null);
});

test("crossing a band fires it exactly once", () => {
  const first = nextBacklogState(BANDS[0].warn, null);
  assert.equal(first.fire, BANDS[0].warn);
  assert.equal(first.next_warned, BANDS[0].warn);

  const again = nextBacklogState(BANDS[0].warn + 1, first.next_warned);
  assert.equal(again.fire, null, "the same band fired twice");
  assert.equal(again.next_warned, BANDS[0].warn);
});

/**
 * 🛑 A JUMP FIRES THE HIGHEST BAND ONLY. A message found 10 hours old must not
 * emit four warnings, and the loudest one is the only one worth reading.
 */
test("a jump straight past every band fires only the highest", () => {
  const top = BANDS[BANDS.length - 1].warn;
  const t = nextBacklogState(top * 10, null);

  assert.equal(t.fire, top);
  assert.equal(t.next_warned, top);
});

/**
 * 🛑 AGE CAN FALL WITHOUT THE BACKLOG EMPTYING, which is the case a reader
 * coming from `gauge.ts` will not expect. Reading the OLDEST unread while a
 * newer one waits drops the age without clearing it, so the band must step
 * down or a later climb never fires again.
 */
test("reading the oldest while a newer one waits steps the band down, silently", () => {
  const t = nextBacklogState(BANDS[0].warn, 240);

  assert.equal(t.fire, null, "a step down fired a warning");
  assert.equal(
    t.next_warned,
    BANDS[0].warn,
    "the band did not follow the age down",
  );
});

test("a step down then a climb fires the band again", () => {
  const down = nextBacklogState(1, 60);
  assert.equal(down.next_warned, null);
  assert.equal(down.fire, null);

  const up = nextBacklogState(60, down.next_warned);
  assert.equal(up.fire, 60, "60 never fired again after a step down");
});

/**
 * ⚠️ NO HYSTERESIS MARGIN, UNLIKE `gauge.ts`, AND THAT IS DELIBERATE.
 *
 * Context percent oscillates around a line on its own, so the gauge needs a
 * 5-point margin. Backlog age only RISES between reads, so the only way it
 * falls is a read — and a read followed by a fresh climb past the same line is
 * a new incident, not chatter.
 */
test("age rising monotonically past one line fires once, not per poll", () => {
  let warned: Threshold | null = null;
  let fires = 0;

  for (const minutes of [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]) {
    const t = nextBacklogState(minutes, warned);
    warned = t.next_warned;
    if (t.fire !== null) fires += 1;
  }

  assert.equal(
    fires,
    1,
    `the 5-minute line fired ${fires} times over one climb`,
  );
});

/**
 * 🛑 THE LOUD BANDS MUST REACH SOMEBODY OTHER THAN THE AGENT IGNORING THE
 * BACKLOG. A DM to a peer that is not reading its DMs is the defect, not the
 * alarm, so the top bands escalate off that channel.
 */
test("the quiet bands DM and the loud bands escalate past the agent", () => {
  const deliveries = BANDS.map((b) => backlogDeliveryFor(b.warn as Threshold));

  assert.deepEqual(
    deliveries,
    ["dm", "dm", "room", "alert"],
    `delivery ramp was ${deliveries.join(" ")}`,
  );
});

/**
 * ⚠️ A BAND'S COPY IS READ ANYWHERE FROM ITS OWN LINE TO THE NEXT ONE, so no
 * band may name its own number. This is `gauge.ts`'s PR 113 defect, and the
 * same shape would reappear here for free.
 */
test("no band's copy hardcodes its own threshold as a duration", () => {
  // Asserting the bare number would false-positive: the 5 band rendered at
  // 15 minutes contains "5" inside "15". `N min` is the shape of the defect.
  for (const band of BANDS) {
    const body = warningBody("claude2", band.warn as Threshold, 137);

    assert.ok(
      !body.includes(`${band.warn} min`),
      `the ${band.warn} band names its own line as a duration: ${body}`,
    );
  }
});

test("every band's copy reports the age it was actually given", () => {
  for (const band of BANDS) {
    const body = warningBody("claude2", band.warn as Threshold, 137);

    assert.match(body, /137/, `the ${band.warn} band dropped the real age`);
  }
});

test("the loud bands name the handle so a room post identifies the agent", () => {
  for (const band of BANDS) {
    const level = band.warn as Threshold;
    if (backlogDeliveryFor(level) === "dm") continue;

    assert.match(
      warningBody("claude2", level, 137),
      /claude2/,
      `the ${band.warn} band leaves a room post anonymous`,
    );
  }
});
