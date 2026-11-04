import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_TTL_MINUTES,
  ttlMinutes,
  isLive,
  decideClaim,
  decideRelease,
  remainingMs,
} from '../../src/claims/lifecycle.js';

/**
 * 🛑 A CLAIM IS A LOCK, AND A LOCK THAT IS WRONG IS SILENT.
 *
 * Before #101 a claim was prose in a chat message: nothing could query it,
 * nothing expired it, and it scrolled out of view while still held. A second
 * agent then starts a 22-minute gate against a tree the first is mid-edit on,
 * and nobody learns until it fails.
 *
 * 🛑 SO EVERY DECISION IS HERE, PURE, AND TESTED WITHOUT A DATABASE. The DAO
 * stores what this returns and decides nothing.
 *
 * lee ruled both open questions on the ticket:
 *   "Claims should have default expiry that is generous, but the onus should
 *    also be to clear them when done. Default is a failsafe."
 *   "Table."
 */

const HOUR = 3_600_000;
const NOW = Date.parse('2026-11-04T12:00:00Z');

const claim = (over: Partial<Parameters<typeof isLive>[0]> = {}) => ({
  id: 1,
  resource: 'reset-and-test.sh',
  holder: 'claude1',
  note: null,
  claimed_at: NOW - 60_000,
  expires_at: NOW + HOUR,
  released_at: null,
  ...over,
});

test('🛑 the default TTL is a generous FAILSAFE, not a working estimate', () => {
  // lee: generous, and the onus stays on the holder to release. A full gate is
  // ~23 minutes, and one ran 8.3 hours when the host slept — so a TTL short
  // enough to be "about right" would release a claim that is still held.
  assert.equal(DEFAULT_TTL_MINUTES, 240);
  assert.ok(DEFAULT_TTL_MINUTES * 60_000 > 23 * 60_000 * 4, 'a TTL under 4 gate-lengths is an estimate, not a failsafe');
});

test('the TTL is overridable, and junk falls back rather than becoming zero', () => {
  assert.equal(ttlMinutes({}), 240);
  assert.equal(ttlMinutes({ CHAT_MCP_CLAIM_TTL_MINUTES: '30' }), 30);

  // A zero or negative TTL would expire every claim on creation, which reads
  // as "nothing is ever claimed" rather than as a misconfiguration.
  assert.equal(ttlMinutes({ CHAT_MCP_CLAIM_TTL_MINUTES: '0' }), 240);
  assert.equal(ttlMinutes({ CHAT_MCP_CLAIM_TTL_MINUTES: '-5' }), 240);
  assert.equal(ttlMinutes({ CHAT_MCP_CLAIM_TTL_MINUTES: 'soon' }), 240);
  assert.equal(ttlMinutes({ CHAT_MCP_CLAIM_TTL_MINUTES: '' }), 240);
});

test('a claim is live until it is released or expires', () => {
  assert.equal(isLive(claim(), NOW), true);
  assert.equal(isLive(claim({ released_at: NOW - 1 }), NOW), false, 'released');
  assert.equal(isLive(claim({ expires_at: NOW - 1 }), NOW), false, 'expired');
  assert.equal(isLive(claim({ expires_at: NOW }), NOW), false, 'expiry is exclusive at the boundary');
});

test('remaining time is reported, and never negative', () => {
  assert.equal(remainingMs(claim({ expires_at: NOW + 5000 }), NOW), 5000);
  assert.equal(remainingMs(claim({ expires_at: NOW - 5000 }), NOW), 0);
});

test('an unheld resource is granted', () => {
  const d = decideClaim({ existing: null, resource: 'leagues_app', holder: 'claude2', now: NOW, ttlMinutes: 240 });

  assert.equal(d.outcome, 'granted');
  assert.equal(d.expires_at, NOW + 240 * 60_000);
});

test('🛑 a resource held by SOMEONE ELSE is REFUSED, and the refusal names the holder', () => {
  // The whole point. A granted second claim is the collision this exists to
  // stop, and an agent cannot act on "someone has it" without knowing who.
  const d = decideClaim({
    existing: claim({ holder: 'claude1', expires_at: NOW + 600_000 }),
    resource: 'reset-and-test.sh',
    holder: 'claude2',
    now: NOW,
    ttlMinutes: 240,
  });

  assert.equal(d.outcome, 'conflict');
  assert.equal(d.heldBy, 'claude1');
  assert.equal(d.remainingMs, 600_000);
});

test('the SAME holder re-claiming renews rather than conflicting', () => {
  // An agent that re-claims mid-hold is extending its own lock, which has to
  // be idempotent or a retry reads as a collision with itself.
  const d = decideClaim({
    existing: claim({ holder: 'claude1' }),
    resource: 'reset-and-test.sh',
    holder: 'claude1',
    now: NOW,
    ttlMinutes: 240,
  });

  assert.equal(d.outcome, 'renewed');
  assert.equal(d.expires_at, NOW + 240 * 60_000);
});

test('🛑 an EXPIRED claim is granted away, and the grant says the failsafe fired', () => {
  // lee's ruling makes expiry a failsafe for an agent that died holding a
  // lock. Granting silently would hide that a claim was never released.
  const d = decideClaim({
    existing: claim({ holder: 'claude1', expires_at: NOW - 1 }),
    resource: 'reset-and-test.sh',
    holder: 'claude2',
    now: NOW,
    ttlMinutes: 240,
  });

  assert.equal(d.outcome, 'granted');
  assert.equal(d.tookOverFrom, 'claude1');
});

test('a released claim is granted away with no takeover note', () => {
  const d = decideClaim({
    existing: claim({ holder: 'claude1', released_at: NOW - 1 }),
    resource: 'reset-and-test.sh',
    holder: 'claude2',
    now: NOW,
    ttlMinutes: 240,
  });

  assert.equal(d.outcome, 'granted');
  assert.equal(d.tookOverFrom, undefined, 'a clean release is not a takeover');
});

test('the holder can release their own claim', () => {
  const d = decideRelease({ existing: claim({ holder: 'claude1' }), by: 'claude1', force: false, now: NOW });

  assert.equal(d.outcome, 'released');
});

test('🛑 a NON-holder cannot release, unless they force it', () => {
  const held = claim({ holder: 'claude1' });

  const refused = decideRelease({ existing: held, by: 'claude2', force: false, now: NOW });
  assert.equal(refused.outcome, 'not-yours');
  assert.equal(refused.heldBy, 'claude1');

  // The override exists because an agent that died holding a claim leaves a
  // lock nobody else can clear. Same split the prune script draws.
  const forced = decideRelease({ existing: held, by: 'claude2', force: true, now: NOW });
  assert.equal(forced.outcome, 'released');
  assert.equal(forced.forcedFrom, 'claude1');
});

test('releasing nothing says so, rather than reporting success', () => {
  assert.equal(decideRelease({ existing: null, by: 'claude1', force: false, now: NOW }).outcome, 'not-held');

  // An already-expired claim needs no release, and saying "released" would
  // imply this call did something.
  assert.equal(
    decideRelease({ existing: claim({ expires_at: NOW - 1 }), by: 'claude1', force: false, now: NOW }).outcome,
    'not-held',
  );
  assert.equal(
    decideRelease({ existing: claim({ released_at: NOW - 1 }), by: 'claude1', force: false, now: NOW }).outcome,
    'not-held',
  );
});

test('🛑 force does NOT let a non-holder release a claim that is already gone', () => {
  // Otherwise `force` reports success for a claim nobody held, which is the
  // "a typo is not a success" rule applied to a lock.
  const d = decideRelease({ existing: claim({ released_at: NOW - 1 }), by: 'claude2', force: true, now: NOW });

  assert.equal(d.outcome, 'not-held');
});
