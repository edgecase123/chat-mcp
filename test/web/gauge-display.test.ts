import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gaugeDisplay, ageLabel } from '../../web/assets/logic.js';

/**
 * #103 — both agents sat at exactly 1000000/1000000 with a 27.7-day-old
 * timestamp and every reader took it as current.
 */

test('a fresh reading shows a percent and its band', () => {
  const g = gaugeDisplay({ context_used: 766561, context_total: 1000000, fresh: true });

  assert.equal(g.show, true);
  assert.equal(g.percent, 77);
  assert.equal(g.band, 'soft');
});

/**
 * 🛑 THE WHOLE POINT. A stale reading must not render its last number —
 * greyed digits are still digits, and digits are what get acted on.
 */
test('a stale reading shows NO percent, however full it claimed to be', () => {
  const g = gaugeDisplay({ context_used: 1000000, context_total: 1000000, fresh: false, age_ms: 2396552000 });

  assert.equal(g.percent, null, 'the stale number leaked through');
  assert.equal(g.band, 'stale');
  assert.match(g.title, /27d old/);
});

test('never reported shows nothing at all', () => {
  assert.equal(gaugeDisplay({}).show, false);
  assert.equal(gaugeDisplay({ context_used: 5, context_total: null }).show, false);
});

/** A zero total would divide by zero and render Infinity%. */
test('a zero total is treated as unreported', () => {
  assert.equal(gaugeDisplay({ context_used: 5, context_total: 0, fresh: true }).show, false);
});

test('the bands match the ones the bus already warns on', () => {
  const at = (p: number) => gaugeDisplay({ context_used: p, context_total: 100, fresh: true }).band;

  assert.equal(at(69), 'ok');
  assert.equal(at(70), 'soft');
  assert.equal(at(85), 'warn');
  assert.equal(at(95), 'crit');
});

test('age reads at a glance and never as raw milliseconds', () => {
  assert.equal(ageLabel(null), 'never reported');
  assert.equal(ageLabel(59 * 60 * 1000), '59m');
  assert.equal(ageLabel(3 * 60 * 60 * 1000), '3h');
  assert.equal(ageLabel(5 * 24 * 60 * 60 * 1000), '5d');
});
