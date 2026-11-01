import { test } from 'node:test';
import assert from 'node:assert/strict';
// The browser file itself, imported directly. No DOM, no bundler, no copy.
import {
  acceptReopens,
  enterShouldSend,
  isPinnedToBottom,
  jumpLabel,
  menuEntriesFor,
  mentionSuggestionsFor,
  mentionTokenAt,
  moveIndex,
  pushHistory,
  historyStep,
  historyKeyApplies,
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

// ── the entry a sidebar row offers ───────────────────────────────────────

test('🛑 a room offers Delete and NEVER Kick', () => {
  const entries = menuEntriesFor('room', '#ops');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].text, 'Delete');
  assert.equal(entries[0].action, 'deleteRoom');
  assert.ok(!entries.some((e) => e.text === 'Kick'), 'Kick does not apply to a room');
});

test('a peer offers Kick and never Delete', () => {
  const entries = menuEntriesFor('peer', 'alice');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].text, 'Kick');
  assert.equal(entries[0].action, 'kickPeer');
  assert.ok(!entries.some((e) => e.text === 'Delete'), 'a peer is not deletable');
});

test('each entry names its own target in the title', () => {
  assert.equal(menuEntriesFor('room', '#gate')[0].title, 'Delete #gate for everyone');
  assert.equal(menuEntriesFor('peer', 'bob')[0].title, 'Remove bob from the bus');
});

test('every action maps to a distinct handler key', () => {
  const actions = [...menuEntriesFor('room', '#ops'), ...menuEntriesFor('peer', 'alice')]
    .map((e) => e.action);
  assert.deepEqual(actions, ['deleteRoom', 'kickPeer']);
});

// ── "#" name type-ahead, for peers AND rooms ────────────────────────────

const MENTION_CTX = {
  // Deliberately out of order, and gatebot shares a prefix with #gate.
  peers: ['claude2', 'claude1', 'leejenkins', 'gatebot'],
  rooms: ['#leagues', '#gate'],
};
// What the composer would hold after accepting the top item.
const accept = (value: string, caret: number) => {
  const s = mentionSuggestionsFor(value, caret, MENTION_CTX);

  return s && { insert: s.items[0].insert, caret: s.items[0].caret, names: s.items.map((i) => i.name) };
};

test('🛑 "@" NEVER triggers. It is reserved for relative file paths.', () => {
  assert.equal(mentionTokenAt('@clau', 5), null);
  assert.equal(accept('tell @clau now', 10), null);
  assert.equal(accept('@', 1), null);
});

test('🛑 a bare word NEVER opens the list, so ordinary typing is not interrupted', () => {
  assert.equal(mentionTokenAt('Hi clau', 7), null);
  assert.equal(accept('Hi clau', 7), null);
});

test('🛑 a "#" inside a word does not open the list', () => {
  assert.equal(mentionTokenAt('I like C#', 9), null, 'the trigger must OPEN a word');
  assert.equal(mentionTokenAt('issue3#4', 8), null);
});

test('"#" alone lists every room and every peer', () => {
  assert.deepEqual(accept('#', 1)!.names,
    ['#gate', '#leagues', 'claude1', 'claude2', 'gatebot', 'leejenkins']);
});

test('the order does not depend on bus join order', () => {
  const a = mentionSuggestionsFor('#', 1, { peers: ['b', 'a'], rooms: ['#z', '#y'] })!;
  assert.deepEqual(a.items.map((i) => i.name), ['#y', '#z', 'a', 'b'], 'rooms first, each group sorted');
});

test('a prefix narrows across both pools', () => {
  assert.deepEqual(accept('#clau', 5)!.names, ['claude1', 'claude2']);
  assert.deepEqual(accept('#gat', 4)!.names, ['#gate', 'gatebot'], 'a room and a peer can both match');
});

test('a prefix that matches nothing returns null, not an empty list', () => {
  assert.equal(accept('#zzz', 4), null);
});

test('🛑 a room keeps its own "#", and a peer does NOT gain one', () => {
  assert.equal(accept('#gat', 4)!.insert, '#gate ', 'the # is part of the room name');
  assert.equal(accept('#clau', 5)!.insert, 'claude1 ', 'the # was only a trigger');
});

test('🛑 accepting mid-token consumes the WHOLE word, leaving no orphan letters', () => {
  // Caret sits inside "clau", between the a and the u.
  assert.equal(accept('tell #clau now', 9)!.insert, 'tell claude1 now');
});

test('🛑 completing before an existing space does not leave two spaces', () => {
  const r = accept('tell #clau now', 10)!;
  assert.equal(r.insert, 'tell claude1 now');
  assert.ok(!r.insert.includes('  '), 'a doubled space is the bug this guards');
});

test('the caret lands after the inserted name, not at the end of the line', () => {
  const r = accept('tell #clau now', 10)!;
  assert.equal(r.caret, 'tell claude1'.length, 'so you can keep typing where you were');
  assert.equal(r.insert.slice(0, r.caret), 'tell claude1');
});

test('a trailing space is added when the name ends the line', () => {
  assert.equal(accept('tell #clau', 10)!.insert, 'tell claude1 ');
});

test('🛑 a completed name no longer offers itself, so the popover closes', () => {
  assert.equal(mentionTokenAt('tell claude1 ', 13), null, 'no trigger left in the line');
  assert.equal(accept('tell #gate ', 11), null, 'the caret is past the word');
});

test('🛑 a slash line is a COMMAND line, and the command path WINS', () => {
  // The precedence app.js uses: command first, mention only on null.
  const pick = (v: string, caret: number) =>
    suggestionsFor(v, CTX) ?? mentionSuggestionsFor(v, caret, MENTION_CTX);

  assert.equal(pick('/dm ali', 7)!.kind, 'arg', 'the command owns its own argument');
  assert.equal(pick('/dm #clau', 9), null, 'a # inside a command never becomes a mention');
  assert.equal(mentionTokenAt('/dm #clau', 9), null, 'the rule lives in the pure function');
  assert.equal(pick('#clau', 5)!.kind, 'mention', 'and a non-slash line falls through');
});

test('duplicate handles are listed once', () => {
  const s = mentionSuggestionsFor('#c', 2, { peers: ['claude1', 'claude1'], rooms: [] });
  assert.deepEqual(s!.items.map((i) => i.name), ['claude1']);
});

test('a caret past the end of the value does not throw', () => {
  assert.equal(accept('#clau', 999)!.insert, 'claude1 ');
  assert.equal(mentionTokenAt('', 5), null);
});

// ── Enter on a mention, which the whole-value rule cannot answer ─────────

test('🛑 Enter SENDS once the typed token IS the name, trigger included', () => {
  const s = mentionSuggestionsFor('#gate', 5, MENTION_CTX)!;
  assert.equal(s.items[s.index].name, '#gate');
  assert.equal(enterShouldSend(s, '#gate'), true, 'otherwise Enter re-accepts forever');
});

test('Enter ACCEPTS a half-typed name', () => {
  assert.equal(enterShouldSend(mentionSuggestionsFor('#gat', 4, MENTION_CTX)!, '#gat'), false);
  assert.equal(enterShouldSend(mentionSuggestionsFor('#clau', 5, MENTION_CTX)!, '#clau'), false);
});

test('🛑 A FULLY TYPED PEER STILL COMPLETES, because its "#" must come off', () => {
  // The defect this pins: comparing the BARE name made "#gate" send with a
  // stray "#" when gate was a peer, while "#clau" completed to "claude1" with
  // none. How much you had typed decided what got sent.
  const ctx = { peers: ['gate'], rooms: [] };
  const s = mentionSuggestionsFor('#gate', 5, ctx)!;
  assert.equal(s.items[0].insert, 'gate ', 'the completion drops the trigger');
  assert.equal(enterShouldSend(s, '#gate'), false, 'so there IS something left to do');
});

test('a room and a peer of the same name diverge, and both are right', () => {
  const asRoom = mentionSuggestionsFor('#gate', 5, { peers: [], rooms: ['#gate'] })!;
  const asPeer = mentionSuggestionsFor('#gate', 5, { peers: ['gate'], rooms: [] })!;
  assert.equal(enterShouldSend(asRoom, '#gate'), true, 'the # is part of the room name');
  assert.equal(enterShouldSend(asPeer, '#gate'), false, 'the # was only a trigger');
});

test('a mistyped case completes rather than sending, so the name is normalised', () => {
  const s = mentionSuggestionsFor('#GATE', 5, MENTION_CTX)!;
  assert.equal(s.items[0].insert, '#gate ');
  assert.equal(enterShouldSend(s, '#GATE'), false);
});

test('🛑 the whole-value test would have been WRONG here, which is the point', () => {
  // The insert carries the rest of the line, so it never equals the value.
  const s = mentionSuggestionsFor('hey #gate', 9, MENTION_CTX)!;
  assert.notEqual(s.items[s.index].insert, 'hey #gate', 'insert differs from value');
  assert.equal(enterShouldSend(s, 'hey #gate'), true, 'and Enter must still send');
});

test('after ArrowDown, Enter completes the newly active name instead', () => {
  // "#gate" is an exact match AND a prefix of "#gateway", which is the only
  // shape where the active item can stop being the typed one.
  const s = mentionSuggestionsFor('#gate', 5, { peers: [], rooms: ['#gate', '#gateway'] })!;
  assert.equal(enterShouldSend(s, '#gate'), true, 'the exact match sends');
  s.index = moveIndex(s.index, 1, s.items.length);
  assert.equal(s.items[s.index].name, '#gateway');
  assert.equal(enterShouldSend(s, '#gate'), false, '#gateway is not what is typed');
});

// ── ArrowUp through sent-line history ───────────────────────────────────

const ring = (...lines: string[]) => lines.reduce((e, l) => pushHistory(e, l), [] as string[]);
type Hist = { entries: string[]; index: number | null; draft: string | null };
const H = (entries: string[], index: number | null = null, draft: string | null = null): Hist =>
  ({ entries, index, draft });

test('consecutive duplicates collapse, because they are one thing to recall', () => {
  assert.deepEqual(ring('a', 'b', 'b', 'b', 'c'), ['a', 'b', 'c']);
  assert.deepEqual(ring('a', 'b', 'a'), ['a', 'b', 'a'], 'only CONSECUTIVE ones collapse');
});

test('a blank or whitespace-only line is never recorded', () => {
  assert.deepEqual(ring('a', '   ', '', '\n', 'b'), ['a', 'b']);
});

test('a line is stored trimmed', () => {
  assert.deepEqual(ring('  padded  '), ['padded']);
});

test('the ring drops the OLDEST once it is full', () => {
  let e: string[] = [];
  for (let i = 0; i < 105; i += 1) e = pushHistory(e, `line${i}`, 100);
  assert.equal(e.length, 100);
  assert.equal(e[0], 'line5', 'the first five are gone');
  assert.equal(e[99], 'line104', 'the newest is last');
});

test('🛑 the FIRST ArrowUp saves the draft you were writing', () => {
  const step = historyStep(H(ring('one', 'two')), -1, 'half a sentence')!;
  assert.equal(step.value, 'two', 'newest entry first');
  assert.equal(step.draft, 'half a sentence', 'losing this is the bug');
  assert.equal(step.index, 1);
});

test('ArrowUp walks back to the oldest and stops there', () => {
  const entries = ring('one', 'two', 'three');
  let h = H(entries);
  const seen: string[] = [];
  for (let i = 0; i < 5; i += 1) {
    const step = historyStep(h, -1, '');
    if (!step) break;
    seen.push(step.value);
    h = { entries, index: step.index, draft: step.draft };
  }
  assert.deepEqual(seen, ['three', 'two', 'one'], 'and the 4th press returns null');
});

test('🛑 ArrowDown past the newest RESTORES the draft, not an empty box', () => {
  const entries = ring('one');
  const up = historyStep(H(entries), -1, 'my draft')!;
  const down = historyStep({ entries, index: up.index, draft: up.draft }, 1, 'one')!;
  assert.equal(down.value, 'my draft');
  assert.equal(down.index, null, 'and we are no longer browsing');
  assert.equal(down.draft, null);
});

test('ArrowDown restores an EMPTY draft as empty, not as the oldest entry', () => {
  const entries = ring('one');
  const up = historyStep(H(entries), -1, '')!;
  const down = historyStep({ entries, index: up.index, draft: up.draft }, 1, 'one')!;
  assert.equal(down.value, '', 'the box you started with was empty');
});

test('ArrowDown does nothing when you were not browsing', () => {
  assert.equal(historyStep(H(ring('one')), 1, 'typing'), null);
});

test('ArrowUp does nothing on an empty ring, so the key stays the browser\'s', () => {
  assert.equal(historyStep(H([]), -1, 'typing'), null);
});

// ── the multi-line guard the CLI composer never needed ──────────────────

test('🛑 ArrowUp does NOT claim the key when there is a line above the caret', () => {
  // Shift-Enter makes newlines here, so the caret must still move between them.
  assert.equal(historyKeyApplies('one\ntwo', 5, -1), false, 'caret on line 2');
  assert.equal(historyKeyApplies('one\ntwo', 2, -1), true, 'caret on line 1');
});

test('ArrowDown does NOT claim the key when there is a line below the caret', () => {
  assert.equal(historyKeyApplies('one\ntwo', 2, 1), false, 'caret on line 1');
  assert.equal(historyKeyApplies('one\ntwo', 5, 1), true, 'caret on the last line');
});

test('a single-line value gives both keys to history', () => {
  assert.equal(historyKeyApplies('one line', 4, -1), true);
  assert.equal(historyKeyApplies('one line', 4, 1), true);
});

test('an out-of-range caret does not throw', () => {
  assert.equal(historyKeyApplies('one', 999, -1), true);
  assert.equal(historyKeyApplies('', 0, 1), true);
});
