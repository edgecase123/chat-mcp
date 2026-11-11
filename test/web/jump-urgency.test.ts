import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JUMP_URGENCY_MS, jumpUrgency, nextUnreadSince } from '../../web/assets/logic.js';

/**
 * 🛑 A MESSAGE THAT ARRIVES WHILE YOU ARE SCROLLED UP CAN SIT UNNOTICED (#121).
 *
 * The jump pill appeared with a count and then never changed again, so one
 * waiting message looked identical to twenty and ten seconds looked identical
 * to ten minutes.
 *
 * ⚠️ NO CLOCK IS READ HERE. `jumpUrgency` takes elapsed time, so every level
 * is reachable without waiting and without faking `Date.now` — which is also
 * why the fixture cannot be too tame to reach the cap.
 */

test('nothing waiting is never louder than the resting border', () => {
  assert.equal(jumpUrgency(0), 0);
  assert.equal(jumpUrgency(-1), 0, 'a clock that went backwards must not escalate');
});

test('🛑 every threshold is REACHED, not just the first', () => {
  const [a, b, c] = JUMP_URGENCY_MS;

  assert.equal(jumpUrgency(a - 1), 0, 'just under the first threshold');
  assert.equal(jumpUrgency(a), 1, 'the boundary itself counts');
  assert.equal(jumpUrgency(b), 2);
  assert.equal(jumpUrgency(c), 3);
});

test('🛑 the last threshold is a CAP — an ignored message does not escalate forever', () => {
  const cap = JUMP_URGENCY_MS.length;

  assert.equal(jumpUrgency(JUMP_URGENCY_MS.at(-1)! * 100), cap);
  assert.equal(jumpUrgency(Number.MAX_SAFE_INTEGER), cap);
});

test('⚠️ a non-finite wait is level 0, not NaN propagated into an attribute', () => {
  // `nowMs - null` is NaN, and NaN >= 3000 is false, so a missing start time
  // would otherwise reach the DOM as data-urgency="NaN".
  assert.equal(jumpUrgency(Number.NaN), 0);
  assert.equal(jumpUrgency(Number.POSITIVE_INFINITY), 0, 'Infinity is not a measured wait');
});

test('the thresholds ascend, or a later one could never be reached', () => {
  const sorted = [...JUMP_URGENCY_MS].sort((x, y) => x - y);

  assert.deepEqual(JUMP_URGENCY_MS, sorted);
  assert.equal(new Set(JUMP_URGENCY_MS).size, JUMP_URGENCY_MS.length, 'a duplicate skips a level');
});

test('🛑 the OLDEST unread sets the clock — a later arrival does NOT restart it', () => {
  const started = nextUnreadSince(null, 1, 1000);

  assert.equal(started, 1000);
  // Two more arrive at 4000 and 9000. In a busy room, restarting here would
  // hold the border at level 0 forever, which is the case this exists for.
  assert.equal(nextUnreadSince(started, 2, 4000), 1000);
  assert.equal(nextUnreadSince(started, 3, 9000), 1000);
  assert.equal(jumpUrgency(9000 - started), 2, 'so by 9000 it has reached level 2');
});

test('reading them clears the clock, and the next run starts fresh', () => {
  assert.equal(nextUnreadSince(1000, 0, 5000), null);
  assert.equal(nextUnreadSince(null, 1, 7000), 7000);
});

test('⚠️ control — restarting the clock on every arrival never escalates', () => {
  // The rejected implementation, run against the trickle above. If this ever
  // passes with `nextUnreadSince` substituted in, the guard has gone.
  const restarting = (_prev: number | null, unread: number, now: number) => (unread <= 0 ? null : now);

  let since = restarting(null, 1, 1000);
  for (const t of [4000, 9000, 16000]) since = restarting(since, 2, t);

  assert.equal(jumpUrgency(16000 - since!), 0, 'the rejected version sits at level 0 at 16s');
  assert.equal(jumpUrgency(16000 - 1000), 3, 'the shipped version is at the cap by then');
});
