import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { BANDS, nextGaugeState, warningBody, deliveryFor, PLANNING_BAND, type Threshold } from '../../src/shim/gauge.js';

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
 * DM LEVEL. One of the two would have been updated.
 *
 * ⚠️ THE TWO COPIES ARE NOW ONE, so naming the old two sites would assert
 * nothing — both are clean because neither routes any more. #213 adds a THIRD
 * reporter, so the guard is that exactly one file consults `deliveryFor`.
 */
test('🛑 exactly one site routes a band, so a new reporter cannot grow a copy', () => {
  // 🛑 THE FILESYSTEM, NOT `git ls-files`. The first cut used git and read
  // zero callers, because the one real caller was a NEW file and git lists
  // only tracked ones. A third copy arrives untracked too.
  const root = new URL('../../src/', import.meta.url);
  const src = readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts'))
    .map((f) => `src/${f}`)
    .sort();

  assert.ok(src.length > 50, `expected the source tree, found ${src.length} files — the glob broke`);

  const callers = src.filter((f) => {
    if (f === 'src/shim/gauge.ts') return false; // where deliveryFor is DEFINED

    return /deliveryFor\s*\(/.test(readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8'));
  });

  assert.deepEqual(
    callers,
    ['src/shim/gauge-report.ts'],
    'band routing exists outside applyContextReport. Call it instead of re-deriving the delivery.',
  );

  // `gauge.ts` is skipped again: its own docblock QUOTES the `fire === 70`
  // this guard exists to ban, and a prose mention is not a comparison.
  for (const f of src.filter((x) => x !== 'src/shim/gauge.ts')) {
    const source = readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8');

    assert.doesNotMatch(source, /fire\s*===\s*\d+/, `${f} compares fire to a literal band`);
  }
});

test('🛑 the web gauge colours every band EXCEPT the planning one', () => {
  // claude1 on PR 113: the previous version of this test asserted the coloured
  // set was [85, 95] and never looked at 70, which IS coloured and IS a dm. So
  // it certified a comment that was false in a new way. The rule is the
  // exclusion, and every included band is now checked by name.
  const logic = readFileSync(new URL('../../web/assets/logic.js', import.meta.url), 'utf8');

  const coloured = BANDS.map((b) => b.warn).filter((n) => n !== PLANNING_BAND);
  assert.deepEqual(coloured, [70, 85, 95], 'the coloured set moved; logic.js and its comment both need rereading');

  for (const n of coloured) {
    assert.ok(logic.includes(`>= ${n}`), `logic.js does not band on ${n}, which is not the planning band`);
  }

  assert.doesNotMatch(
    logic,
    new RegExp(`>= ${PLANNING_BAND}\\b`),
    'logic.js colours the planning band. A plan is not an escalation.',
  );
});

test('🛑 no band names its own number in its copy, because it is read up to the NEXT band', () => {
  // claude1 on PR 113: `fire` holds the highest band crossed, so a fresh peer
  // at 68% fires 50 and read "68.0% context — half of it".
  const edges: Array<[Threshold, number]> = [
    [50, 69.9],
    [70, 84.9],
    [85, 94.9],
    [95, 100],
  ];

  for (const [level, top] of edges) {
    const body = warningBody('claude2', level, top);

    assert.ok(body.includes(top.toFixed(1)), `band ${level} does not report the percent it was given`);
    assert.doesNotMatch(
      body,
      /half of it|exactly|three quarters/i,
      `band ${level} claims a fraction, but its copy is read from ${level}% up to ${top}%`,
    );
  }
});
