import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RateLimitGate, parseRateLimitEvent } from '../../src/supervise/rate-limit.js';

/** What a driver does: parse its own shape, hand over a normalised snapshot. */
const feed = (g: RateLimitGate, event: Record<string, unknown>): void => {
  const snap = parseRateLimitEvent(event);

  if (snap) g.update(snap);
};

/** The exact payload observed from a live run on 2026-10-16. */
const LIVE = {
  type: 'rate_limit_event',
  rate_limit_info: {
    status: 'allowed',
    resetsAt: 1792192800,
    rateLimitType: 'five_hour',
    overageStatus: 'rejected',
    overageDisabledReason: 'org_level_disabled',
    isUsingOverage: false,
    unifiedWindows: {
      five_hour: { utilization: 0.52, resetsAt: 1792192800 },
      seven_day: { utilization: 0.33, resetsAt: 1792458000 },
    },
  },
};

const at = (five: number, seven = 0.1, status = 'allowed', overage = 'rejected') => ({
  type: 'rate_limit_event',
  rate_limit_info: {
    status,
    overageStatus: overage,
    unifiedWindows: {
      five_hour: { utilization: five, resetsAt: 123 },
      seven_day: { utilization: seven, resetsAt: 456 },
    },
  },
});

test('the real observed payload parses, both windows and all', () => {
  const s = parseRateLimitEvent(LIVE)!;

  assert.equal(s.status, 'allowed');
  assert.equal(s.windows.five_hour!.utilization, 0.52);
  assert.equal(s.windows.seven_day!.utilization, 0.33);
  // overageStatus is "rejected": a full window REFUSES, it does not bill.
  assert.equal(s.overageAvailable, false);
});

test('a non-rate-limit event parses to null rather than a default snapshot', () => {
  assert.equal(parseRateLimitEvent({ type: 'result' }), null);
  assert.equal(parseRateLimitEvent({ type: 'rate_limit_event' }), null);
});

test('BEFORE any event the gate allows, and reports UNKNOWN not within-budget', () => {
  // 🛑 Failing closed would mean never dispatching — there is no rate-limit
  // event before the first turn. But "not checked" must never read as "fine".
  const v = new RateLimitGate().verdict();

  assert.equal(v.allow, true);
  assert.equal(v.reason, 'unknown');
});

test('at the live 52% it allows, and says within-budget', () => {
  const g = new RateLimitGate();
  feed(g, LIVE);

  assert.deepEqual(g.verdict(), { allow: true, reason: 'within-budget' });
});

test('at or above the ceiling it REFUSES and names the window', () => {
  const g = new RateLimitGate(0.9);
  feed(g, at(0.9));

  const v = g.verdict();
  assert.equal(v.allow, false);
  assert.match(v.reason, /five_hour window at 90%/);
  assert.equal(v.allow === false ? v.resetsAt : null, 123);
});

test('the refusal says overage is REJECTED, because that is why it matters', () => {
  const g = new RateLimitGate(0.5);
  feed(g, at(0.6));

  const v = g.verdict();
  assert.equal(v.allow, false);
  assert.match(v.reason, /overage is REJECTED/);
});

test('with overage AVAILABLE the refusal drops that clause', () => {
  const g = new RateLimitGate(0.5);
  feed(g, at(0.6, 0.1, 'allowed', 'allowed'));

  assert.ok(!/overage is REJECTED/.test((g.verdict() as { reason: string }).reason));
});

test('the SEVEN-DAY window blocks even when five-hour is idle', () => {
  // The slow window is the one that is easy to forget.
  const g = new RateLimitGate(0.9);
  feed(g, at(0.01, 0.95));

  const v = g.verdict();
  assert.equal(v.allow, false);
  assert.match(v.reason, /seven_day window at 95%/);
});

test('a non-allowed status refuses regardless of utilization', () => {
  const g = new RateLimitGate(0.9);
  feed(g, at(0.01, 0.01, 'blocked'));

  const v = g.verdict();
  assert.equal(v.allow, false);
  assert.match(v.reason, /status "blocked"/);
});

test('describe() reports UTILIZATION and never a dollar figure', () => {
  const g = new RateLimitGate();

  assert.match(g.describe(), /not yet observed/);

  feed(g, LIVE);
  const d = g.describe();

  assert.match(d, /five_hour 52%/);
  assert.match(d, /seven_day 33%/);
  assert.match(d, /overage=REJECTED/);
  assert.ok(!d.includes('$'), 'dollars are notional on a subscription');
});

test('a later event replaces the earlier snapshot', () => {
  const g = new RateLimitGate(0.9);
  feed(g, at(0.95));
  assert.equal(g.verdict().allow, false);

  feed(g, at(0.10));
  assert.equal(g.verdict().allow, true);
});
