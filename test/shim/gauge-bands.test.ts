import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BANDS, nextGaugeState, warningBody, deliveryFor, type Threshold } from '../../src/shim/gauge.js';

/**
 * 🛑 THE STATE MACHINE HAD NO TEST AT ALL BEFORE THIS FILE.
 *
 * `nextGaugeState` and `warningBody` were the whole warning contract and
 * nothing exercised either. The 50% planning band (#105) adds a fourth band
 * and a second DM level, so the parts most likely to break are the step-down
 * chain and the DM-versus-room routing.
 */

test('the bands are ascending with a 5-point hysteresis, as a property rather than a list', () => {
  // A list would restate the source. This asserts the shape a new band must
  // keep, so adding a fifth one cannot quietly break the pattern.
  assert.ok(BANDS.length >= 4, `expected at least 4 bands, found ${BANDS.length}`);

  for (const [i, band] of BANDS.entries()) {
    assert.equal(band.warn - band.reset, 5, `band ${band.warn} has a ${band.warn - band.reset}-point hysteresis`);
    if (i > 0) assert.ok(band.warn > BANDS[i - 1].warn, `band ${band.warn} does not sit above ${BANDS[i - 1].warn}`);
  }
});

test('🛑 the planning band is 50, which is the one #105 exists to add', () => {
  assert.deepEqual(
    BANDS.map((b) => b.warn),
    [50, 70, 85, 95],
  );
});

test('crossing 50 from a fresh peer fires once and records the band', () => {
  assert.deepEqual(nextGaugeState(51, null), { next_warned: 50, fire: 50 });
});

test('sitting above the reset line does not re-fire', () => {
  assert.deepEqual(nextGaugeState(60, 50), { next_warned: 50, fire: null });
  assert.deepEqual(nextGaugeState(46, 50), { next_warned: 50, fire: null });
});

test('dropping under 45 clears the state, so a later climb warns again', () => {
  assert.deepEqual(nextGaugeState(44, 50), { next_warned: null, fire: null });
  assert.deepEqual(nextGaugeState(51, null), { next_warned: 50, fire: 50 });
});

test('🛑 a jump straight to critical fires 95 ALONE, not every band on the way', () => {
  // Four bands make this worse than three did: an unguarded loop would send
  // the peer four messages for one report.
  assert.deepEqual(nextGaugeState(97, null), { next_warned: 95, fire: 95 });
});

test('the step-down chain reaches 50 before null', () => {
  assert.deepEqual(nextGaugeState(66, 70), { next_warned: 70, fire: null }, '66 is above 70s reset of 65');
  assert.deepEqual(nextGaugeState(64, 70), { next_warned: 50, fire: null }, '64 clears 70 and lands on 50');
  assert.deepEqual(nextGaugeState(51, 50), { next_warned: 50, fire: null });
});

/**
 * 🛑 THE DOCBLOCK USED TO SAY "one band at a time" AND THE CODE NEVER DID.
 *
 * The step-downs are sequential `if`s, so one report cascades as far as the
 * percent warrants. Measured, then the comment was corrected to match. The
 * cascade is the RIGHT behaviour: after a `/clear` from 95% to 5% the state
 * must reach null, or a climb back to 71% would never fire 70 again.
 */
test('a /clear-sized drop cascades all the way to null in ONE report', () => {
  assert.deepEqual(nextGaugeState(5, 95), { next_warned: null, fire: null });
});

test('🛑 50 and 70 are DM-only; 85 posts to rooms; 95 posts as an alert', () => {
  // lee, 2026-11-04, choosing between DM-only and a room post at 50: "DM only".
  assert.equal(deliveryFor(50), 'dm');
  assert.equal(deliveryFor(70), 'dm');
  assert.equal(deliveryFor(85), 'room');
  assert.equal(deliveryFor(95), 'alert');
});

test('every band has a delivery and a body, so a new band cannot ship silently', () => {
  // Without this, adding a band to BANDS and forgetting either function
  // yields `undefined` at runtime in a path no other test walks.
  for (const band of BANDS) {
    const level = band.warn as Threshold;

    assert.ok(['dm', 'room', 'alert'].includes(deliveryFor(level)), `band ${level} has no delivery`);
    assert.match(warningBody('claude2', level, 51.2), /\S/, `band ${level} has no body copy`);
  }
});

test('🛑 the 50 body asks for a BREAK POINT; the 70 body asks for a compact', () => {
  // The whole value of a fourth band is that its sentence differs. A 50 that
  // merely repeats "consider /compact" earlier is noise, not a planning line.
  const plan = warningBody('claude2', 50, 50.4);
  const soft = warningBody('claude2', 70, 70.4);

  assert.match(plan, /break point/i);
  assert.doesNotMatch(plan, /compact/i, 'the planning line must not read as a hygiene instruction');
  assert.match(soft, /compact/i);
  assert.notEqual(plan, soft);
});

/**
 * 🛑 THE ROUTING LIVED AS `fire === 70` IN TWO FILES, AND #105 ADDS A SECOND
 * DM LEVEL. One of the two would have been updated. This is the guard.
 */
test('🛑 neither report_context hardcodes a band number for routing', () => {
  const sites = ['src/oneshot/report_context.ts', 'src/shim/tools/report_context.ts'];

  for (const site of sites) {
    const source = readFileSync(new URL(`../../${site}`, import.meta.url), 'utf8');

    assert.doesNotMatch(
      source,
      /fire\s*===\s*\d+/,
      `${site} compares fire to a literal band. Use deliveryFor() so one definition serves both sites.`,
    );
    assert.match(source, /deliveryFor/, `${site} does not consult deliveryFor()`);
  }
});

test("the web gauge's colours mirror the ROOM-POST bands, and its comment says which", () => {
  // claude1's 🟡 on PR 110: logic.js hardcodes 95/85/70 under a comment
  // claiming it matches the bus. #105 adds a band the UI deliberately does
  // NOT colour, because a DM-only level earns no visual escalation.
  const logic = readFileSync(new URL('../../web/assets/logic.js', import.meta.url), 'utf8');

  const roomBands = BANDS.filter((b) => deliveryFor(b.warn as Threshold) !== 'dm').map((b) => b.warn);
  assert.deepEqual(roomBands, [85, 95], 'the room-post bands moved; the UI comment and this test both need rereading');

  for (const n of roomBands) {
    assert.ok(logic.includes(`>= ${n}`), `logic.js does not band on ${n}`);
  }

  assert.doesNotMatch(
    logic,
    />= 50/,
    'logic.js colours the 50 band. lee chose DM-only, so 50 earns no colour.',
  );
});
