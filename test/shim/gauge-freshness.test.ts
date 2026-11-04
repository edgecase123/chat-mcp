import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GAUGE_STALE_AFTER_MS, gaugeFreshness } from '../../src/shim/gauge-freshness.js';

/**
 * #103 / #108 — on 2026-11-04 both agents' gauges read exactly
 * `1000000/1000000` and the last report was 27.7 days old. Nothing said so,
 * because `list_agents` and `whoami` emitted `context_reported_at` raw and no
 * reader subtracted it from now.
 */

const NOW = 1_800_000_000_000;

test('a reading from a moment ago is fresh', () => {
  assert.deepEqual(gaugeFreshness(NOW - 1000, NOW), { fresh: true, age_ms: 1000 });
});

test('a reading exactly at the boundary is still fresh', () => {
  const r = gaugeFreshness(NOW - GAUGE_STALE_AFTER_MS, NOW);

  assert.equal(r.fresh, true, 'the boundary itself must not tip over');
});

test('one millisecond past the boundary is stale', () => {
  const r = gaugeFreshness(NOW - GAUGE_STALE_AFTER_MS - 1, NOW);

  assert.equal(r.fresh, false);
});

/**
 * The case that prompted this. 27.7 days, reported as fresh by every reader
 * that existed before it.
 */
test('the 28-day-old reading that nobody noticed is stale', () => {
  const twentyEightDays = 28 * 24 * 60 * 60 * 1000;
  const r = gaugeFreshness(NOW - twentyEightDays, NOW);

  assert.equal(r.fresh, false);
  assert.equal(r.age_ms, twentyEightDays);
});

/**
 * 🛑 NEVER-REPORTED IS NOT STALE-ZERO. `age_ms: 0` would read as "reported
 * just now", the exact inversion. Null says there is nothing to age.
 */
test('never reported is not fresh, and its age is null rather than zero', () => {
  assert.deepEqual(gaugeFreshness(null, NOW), { fresh: false, age_ms: null });
  assert.deepEqual(gaugeFreshness(undefined, NOW), { fresh: false, age_ms: null });
});

/**
 * Two machines, two clocks. A future timestamp is a disagreement, not a
 * reading yet to happen — and a negative age would render as a nonsense
 * duration.
 */
test('a reading from the future clamps to zero rather than going negative', () => {
  const r = gaugeFreshness(NOW + 60_000, NOW);

  assert.equal(r.age_ms, 0);
  assert.equal(r.fresh, true);
});

test('the threshold is an argument, so a caller can be stricter', () => {
  assert.equal(gaugeFreshness(NOW - 5000, NOW, 1000).fresh, false);
  assert.equal(gaugeFreshness(NOW - 5000, NOW, 10_000).fresh, true);
});

/**
 * The constant is load-bearing: the feeding hook fires on every tool call, so
 * a working agent refreshes many times a minute. Pinned so a later edit has to
 * mean it.
 */
test('the staleness window is fifteen minutes', () => {
  assert.equal(GAUGE_STALE_AFTER_MS, 15 * 60 * 1000);
});
