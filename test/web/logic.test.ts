import { test } from 'node:test';
import assert from 'node:assert/strict';
// The browser file itself, imported directly. No DOM, no bundler, no copy.
import {
  acceptReopens,
  enterShouldSend,
  isPinnedToBottom,
  jumpLabel,
  moveIndex,
  nextUnreadBelow,
  shouldShowJump,
  suggestionsFor,
// @ts-expect-error — plain JS with JSDoc types, deliberately not compiled.
} from '../../web/assets/logic.js';

/**
 * 🛑 WHY THESE ARE PURE RATHER THAN DOM TESTS.
 *
 * Measured 2026-11-01 for chat-mcp#52: happy-dom reports `clientHeight` and
 * `scrollHeight` as 0 for an element that overflows. Every scroll assertion
 * written against it would pass while proving nothing. Taking the geometry as
 * an argument is what makes the decision testable.
 *
 * What is still NOT covered: the event wiring in app.js. That needs a real
 * browser and is out of scope here.
 */

const GEO = (scrollTop: number, scrollHeight: number, clientHeight: number) =>
  ({ scrollTop, scrollHeight, clientHeight });

const COMMANDS = [
  { name: 'dm', arg: '<peer>', desc: 'open a DM', suggest: 'peer', cat: 'conversation' },
  { name: 'join', arg: '<#room>', desc: 'join a room', suggest: 'room', cat: 'conversation' },
  { name: 'alert', arg: '<target> <text>', desc: 'urgent', suggest: 'any', cat: 'messaging' },
  { name: 'who', arg: '', desc: 'list peers', cat: 'status' },
  { name: 'whoami', arg: '', desc: 'your handle', cat: 'status' },
  { name: 'help', arg: '', desc: 'this list', cat: 'system' },
];
const CTX = { commands: COMMANDS, peers: ['alice', 'bob'], rooms: ['#ops', '#gate'] };

// ── scroll anchoring ─────────────────────────────────────────────────────

test('at the bottom is pinned, and a fractional gap still counts', () => {
  assert.equal(isPinnedToBottom(GEO(900, 1000, 100)), true);
  assert.equal(isPinnedToBottom(GEO(899.6, 1000, 100)), true, 'sub-pixel gap broke the equality');
});

test('scrolled up is not pinned, so a render must hold position', () => {
  assert.equal(isPinnedToBottom(GEO(0, 1000, 100)), false);
  assert.equal(isPinnedToBottom(GEO(875, 1000, 100)), false, '25px is past the 24px tolerance');
});

test('unread accrues while away from the bottom and resets when pinned', () => {
  assert.equal(nextUnreadBelow(0, 2, false), 2);
  assert.equal(nextUnreadBelow(2, 1, false), 3);
  assert.equal(nextUnreadBelow(3, 1, true), 0, 'being at the bottom means nothing was missed');
  assert.equal(nextUnreadBelow(2, -5, false), 2, 'a shrinking list cannot subtract unread');
});

// ── the jump badge ───────────────────────────────────────────────────────

test('the badge shows for new messages OR for being far up, independently', () => {
  assert.equal(shouldShowJump(0, GEO(900, 1000, 100)), false, 'at the bottom, nothing new');
  assert.equal(shouldShowJump(2, GEO(0, 5000, 100)), true);
  assert.equal(shouldShowJump(0, GEO(0, 5000, 100)), true, 'far up with nothing new still offers the jump');
});

test('pinned-with-unread cannot occur, so the badge never has to decide it', () => {
  // An earlier version of this file asserted shouldShowJump(1, <pinned>) is
  // false. That is a state the app cannot reach: being pinned is exactly what
  // zeroes the tally. Asserting an impossible state tests a fiction, so the
  // invariant is asserted instead.
  assert.equal(nextUnreadBelow(5, 3, true), 0);
});

test('a small nudge up does not arm the badge', () => {
  assert.equal(shouldShowJump(0, GEO(800, 1000, 100)), false, '100px up is a glance, not reading');
});

test('the threshold is a viewport on a tall window, not a fixed 240px', () => {
  // 500px up, 900px viewport: still a glance.
  assert.equal(shouldShowJump(0, GEO(0, 1400, 900)), false);
  assert.equal(shouldShowJump(0, GEO(0, 2000, 900)), true);
});

test('the label says what is waiting, and gets the plural right', () => {
  assert.equal(jumpLabel(1), '1 new message ↓  (End)');
  assert.equal(jumpLabel(2), '2 new messages ↓  (End)');
  assert.equal(jumpLabel(0), 'Jump to newest ↓  (End)');
});

// ── composer suggestions ─────────────────────────────────────────────────

test('ordinary typing is never interrupted', () => {
  assert.equal(suggestionsFor('hello there', CTX), null);
  assert.equal(suggestionsFor('', CTX), null);
  assert.equal(suggestionsFor('/dm alice\nsecond line', CTX), null);
});

test('a slash lists commands, and typing filters them', () => {
  assert.equal(suggestionsFor('/', CTX).items.length, COMMANDS.length);
  assert.deepEqual(suggestionsFor('/jo', CTX).items.map((i: any) => i.name), ['/join']);
  assert.equal(suggestionsFor('/nope', CTX), null);
});

test('a command that takes an argument suggests the right pool', () => {
  assert.deepEqual(suggestionsFor('/dm ', CTX).items.map((i: any) => i.name), ['alice', 'bob']);
  assert.deepEqual(suggestionsFor('/join ', CTX).items.map((i: any) => i.name), ['#ops', '#gate']);
  assert.equal(suggestionsFor('/alert ', CTX).items.length, 4, '/alert takes either');
});

test('a # prefix is ignored when matching a room', () => {
  assert.deepEqual(suggestionsFor('/join #op', CTX).items.map((i: any) => i.name), ['#ops']);
  assert.deepEqual(suggestionsFor('/join op', CTX).items.map((i: any) => i.name), ['#ops']);
});

test('a command with no argument suggests nothing after its space', () => {
  assert.equal(suggestionsFor('/who ', CTX), null);
});

// ── the Enter rule that unstuck "/help" ──────────────────────────────────

test('🛑 Enter SENDS once the input already equals what accepting would insert', () => {
  const s = suggestionsFor('/help', CTX);
  assert.equal(enterShouldSend(s, '/help'), true, 'this is the bug lee hit: /help was stuck');
});

test('Enter ACCEPTS a half-typed command', () => {
  assert.equal(enterShouldSend(suggestionsFor('/hel', CTX), '/hel'), false);
});

test('"/who" still reaches "/whoami", because that insert differs', () => {
  const s = suggestionsFor('/who', CTX);
  assert.equal(s.items[0].name, '/who');
  assert.equal(enterShouldSend(s, '/who'), true, 'the exact match sends');
  s.index = moveIndex(s.index, 1, s.items.length);
  assert.equal(s.items[s.index].name, '/whoami');
  assert.equal(enterShouldSend(s, '/who'), false, 'after ArrowDown it completes instead');
});

test('Enter sends when nothing is open at all', () => {
  assert.equal(enterShouldSend(null, 'a normal message'), true);
});

test('accepting reopens only for a command that takes an argument', () => {
  assert.equal(acceptReopens('/dm '), true);
  assert.equal(acceptReopens('/help'), false, '/help reopening on itself is what stuck Enter');
});

test('the list wraps in both directions', () => {
  assert.equal(moveIndex(0, -1, 3), 2);
  assert.equal(moveIndex(2, 1, 3), 0);
  assert.equal(moveIndex(0, 1, 0), 0, 'an empty list cannot divide by zero');
});
