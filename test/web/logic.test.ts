import { test } from 'node:test';
import assert from 'node:assert/strict';
// The browser file itself, imported directly. No DOM, no bundler, no copy.
import {
  styleSelection,
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
  atTokenAt,
  cheatSheet,
  commandBlock,
  dashColumn,
  messageMarkdown,
  pathSuggestionsFor,
  nextUnreadBelow,
  shouldShowJump,
  suggestionsFor,
// @ts-expect-error — plain JS with JSDoc types, deliberately not compiled.
  pathsFromUriList,
  droppedPathValue,
  dropInsertText,
  dropNameText,
  clearConfirmText,
  clearResultText,
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

const ROOM = menuEntriesFor('room', '#ops');
const PEER = menuEntriesFor('peer', 'alice');
const texts = (entries: { text: string }[]) => entries.map((e) => e.text);

test('🛑 a room offers Delete and NEVER Kick', () => {
  assert.deepEqual(texts(ROOM), ['Broadcast…', 'Alert…', 'Copy name', 'Leave', 'Delete']);
  assert.ok(!texts(ROOM).includes('Kick'), 'Kick does not apply to a room');
});

test('🛑 a peer offers Kick, and never Delete or Leave', () => {
  assert.deepEqual(texts(PEER), ['Dispatch…', 'Alert…', 'Copy handle', 'Kick']);
  assert.ok(!texts(PEER).includes('Delete'), 'a peer is not deletable');
  assert.ok(!texts(PEER).includes('Leave'), 'a DM is not a membership');
});

test('🛑 a room BROADCASTS and a peer DISPATCHES. The verbs never cross.', () => {
  assert.ok(!texts(ROOM).includes('Dispatch…'), 'a room does not take the peer verb');
  assert.ok(!texts(PEER).includes('Broadcast…'), 'a peer does not take the room verb');
});

/**
 * 🛑 EXACTLY ONE DESTRUCTIVE ENTRY, AND IT IS LAST.
 *
 * Kick and Delete used to be the ONLY entries, so the menu could not be
 * opened into anything else. Now that they have neighbours, last position is
 * what keeps a mis-click off them, and the CSS rules a line above whatever
 * carries this flag.
 */
test('exactly one destructive entry per kind, and it is the last one', () => {
  for (const [kind, entries] of [['room', ROOM], ['peer', PEER]] as const) {
    const flagged = entries.filter((e) => e.destructive);
    assert.equal(flagged.length, 1, `${kind} must mark exactly one entry destructive`);
    assert.equal(entries.at(-1), flagged[0], `${kind}'s destructive entry must be last`);
  }
});

/** ⚠️ The ellipsis is the only thing telling you nothing will be sent. */
test('an entry carries a prefill if and only if its label ends in an ellipsis', () => {
  for (const e of [...ROOM, ...PEER]) {
    assert.equal(
      Boolean(e.prefill),
      e.text.endsWith('…'),
      `"${e.text}" must say in its label whether it opens in the composer`,
    );
  }
});

test('a prefill is a complete command line, already targeted, with a trailing space', () => {
  const prefills = Object.fromEntries(
    [...ROOM, ...PEER].filter((e) => e.prefill).map((e) => [e.text + e.prefill!.split(' ')[1], e.prefill]),
  );
  assert.deepEqual(prefills, {
    'Broadcast…#ops': '/broadcast #ops ',
    'Alert…#ops': '/alert #ops ',
    'Dispatch…alice': '/dispatch alice ',
    'Alert…alice': '/alert alice ',
  });
});

/**
 * ⚠️ THE CROSS-FILE DRIFT THIS CANNOT SEE. The command table is in app.js,
 * so renaming `/dispatch` there leaves this prefill pointing at a command
 * that no longer exists and nothing throws. This pins the three names so the
 * rename breaks a test instead of only the feature.
 */
test('every prefill names one of the three commands a menu is allowed to open', () => {
  const used = [...ROOM, ...PEER].filter((e) => e.prefill).map((e) => e.prefill!.split(' ')[0]);
  assert.equal(used.length, 4, 'four prefill entries across the two menus');
  assert.deepEqual([...new Set(used)].sort(), ['/alert', '/broadcast', '/dispatch']);
});

test('each entry names its own target in the title', () => {
  assert.equal(menuEntriesFor('room', '#gate').at(-1)!.title, 'Delete #gate for everyone');
  assert.equal(menuEntriesFor('peer', 'bob').at(-1)!.title, 'Remove bob from the bus');
  assert.ok(menuEntriesFor('room', '#gate')[0]!.title.includes('#gate'));
});

/** Every action must reach a handler, and app.js keys them by this string. */
test('every action is one app.js has a handler for', () => {
  const known = ['prefill', 'copyName', 'leaveRoom', 'deleteRoom', 'kickPeer'];
  for (const e of [...ROOM, ...PEER]) {
    assert.ok(known.includes(e.action), `no handler key for "${e.action}"`);
  }
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

// ── the per-message copy button ─────────────────────────────────────────

const MSG = { from: 'claude1', time: '22:42', body: 'Fixed the **gate**. See `logic.js`.' };

test('🛑 a plain copy is the sender\'s own markdown, byte for byte', () => {
  assert.equal(messageMarkdown(MSG), 'Fixed the **gate**. See `logic.js`.');
});

test('🛑 a plain copy does NOT trim, because it is the source', () => {
  assert.equal(messageMarkdown({ ...MSG, body: '  x  \n' }), '  x  \n');
});

test('Shift adds the author and the time as a markdown line', () => {
  assert.equal(
    messageMarkdown(MSG, { attributed: true }),
    '**claude1** · 22:42\n\nFixed the **gate**. See `logic.js`.',
  );
});

test('the attributed form keeps a blank line, so the body is its own block', () => {
  const out = messageMarkdown(MSG, { attributed: true });
  assert.ok(out.includes('\n\n'), 'without it the body folds into the heading line');
});

test('a multi-line body survives, with only its trailing blank lines dropped', () => {
  assert.equal(
    messageMarkdown({ ...MSG, body: 'one\ntwo\n\n' }, { attributed: true }),
    '**claude1** · 22:42\n\none\ntwo',
  );
});

test('an empty body still produces a usable attributed block', () => {
  assert.equal(messageMarkdown({ ...MSG, body: '' }, { attributed: true }), '**claude1** · 22:42\n\n');
  assert.equal(messageMarkdown({ ...MSG, body: '' }), '');
});

test('🛑 a body containing markdown is NOT re-escaped', () => {
  // The body IS markdown. Escaping it would break the thing being copied.
  const body = '```js\nconst a = 1;\n```';
  assert.equal(messageMarkdown({ ...MSG, body }), body);
  assert.ok(messageMarkdown({ ...MSG, body }, { attributed: true }).endsWith(body));
});

test('a handle with markdown characters is not mangled in the heading', () => {
  const out = messageMarkdown({ ...MSG, from: 'claude_2' }, { attributed: true });
  assert.ok(out.startsWith('**claude_2** · 22:42'), 'the handle goes in verbatim');
});

// ── /cheat-sheet ────────────────────────────────────────────────────────

const LABELS = {
  conversation: 'CONVERSATION',
  messaging: 'MESSAGING',
  status: 'STATUS',
  admin: 'ADMIN — destructive',
  system: 'SYSTEM',
};
// 🛑 SEVERAL CATEGORIES CARRY TWO COMMANDS ON PURPOSE. With one each, a
// mutant that keeps only the FIRST command per category drops nothing, and
// the drift guard below passes while detecting nothing. Measured.
const CMDS = [
  { name: 'dm', arg: '<peer>', desc: 'open a DM', cat: 'conversation' },
  { name: 'join', arg: '<#room>', desc: 'join a room', cat: 'conversation' },
  { name: 'alert', arg: '<target> <text>', desc: 'urgent', cat: 'messaging' },
  { name: 'dispatch', arg: '<peer> <text>', desc: 'hand over a task', cat: 'messaging' },
  { name: 'who', arg: '', desc: 'list peers', cat: 'status' },
  { name: 'kick', arg: '<peer>', desc: 'remove a peer', cat: 'admin' },
  { name: 'help', arg: '', desc: 'the short list', cat: 'system' },
  { name: 'cheat-sheet', arg: '', desc: 'this sheet', cat: 'system' },
];

test('🛑 the WIDEST command still keeps a space before its dash', () => {
  // A hardcoded pad let `/broadcast <#room> <text>` overflow and collide.
  const collided = commandBlock(WIDE, LABELS).split('\n').filter((l) => /\S—/.test(l));
  assert.deepEqual(collided, [], 'a usage wider than the pad ran into its description');
  // The denominator: the added command really is the widest in the table.
  assert.equal(dashColumn(WIDE.map((c) => `/${c.name} ${c.arg}`.trimEnd())), 26);
});

test('🛑 EVERY dash in the sheet sits at ONE column, commands and gestures alike', () => {
  // Padding the command rows alone splits the sheet into two tables. Measured
  // at 28 and 26 on the first cut of this fix, which `includes(block)` cannot
  // see because each section is internally consistent.
  // A category heading can itself contain an em-dash ("ADMIN — destructive"),
  // so headings are excluded by name rather than by looking for the character.
  const headings = new Set(Object.values(LABELS).map((h) => `  ${h}`));
  const lines = cheatSheet(WIDE, LABELS)
    .split('\n')
    .filter((l) => l.includes('—') && !headings.has(l));
  const columns = [...new Set(lines.map((l) => l.indexOf('—')))];
  assert.deepEqual(columns, [26 + 2], 'the sheet has more than one dash column');
  // The denominators: both halves are really in that count.
  assert.ok(lines.some((l) => l.includes('/broadcast')), 'no command row was measured');
  assert.ok(lines.some((l) => l.includes('Shift-Enter')), 'no gesture row was measured');
  assert.ok(lines.length >= WIDE.length + 10, `only ${lines.length} rows carried a dash`);
});

test('the toast outdents its category headings and the sheet indents them', () => {
  const flush = commandBlock(CMDS, LABELS, { headingIndent: '' });
  assert.ok(flush.includes('\nCONVERSATION') || flush.startsWith('CONVERSATION'));
  assert.ok(commandBlock(CMDS, LABELS).includes('  CONVERSATION'), 'the sheet default indents');
});

const WIDE = [...CMDS, { name: 'broadcast', arg: '<#room> <text>', desc: 'to a room', cat: 'messaging' }];

/** Every non-blank line, trimmed and space-collapsed, so padding cannot matter. */
const squash = (text: string) =>
  text.split('\n').map((l) => l.trim().replace(/\s+/g, ' ')).filter(Boolean);

test('🛑 /help and /cheat-sheet print the SAME command rows', () => {
  // Two builders is how one new command gets described two different ways
  // depending on which of the two you typed. The column differs by surface on
  // purpose, so this compares the TEXT and the dash-column test owns the pad.
  const toast = squash(commandBlock(WIDE, LABELS, { headingIndent: '' }));
  const sheet = squash(cheatSheet(WIDE, LABELS));
  const missing = toast.filter((row) => !sheet.includes(row));
  assert.deepEqual(missing, [], 'the sheet does not carry what the toast prints');
  // The denominator, so a toast that silently shrank cannot pass the above.
  assert.equal(toast.filter((l) => l.startsWith('/')).length, WIDE.length);
  assert.equal(WIDE.length, 9);
});

test('🛑 EVERY command in the table reaches the sheet', () => {
  const sheet = cheatSheet(CMDS, LABELS);
  const missing = CMDS.filter((c) => !sheet.includes(`/${c.name}`)).map((c) => c.name);
  assert.deepEqual(missing, [], 'a hand-written list is what this guards against');
  assert.equal(CMDS.length, 8, 'and the check is over all eight, not a subset');
  // The denominator that makes the check meaningful: a category with two.
  assert.equal(CMDS.filter((c) => c.cat === 'conversation').length, 2);
});

test('every command carries its argument and its description', () => {
  const sheet = cheatSheet(CMDS, LABELS);
  for (const c of CMDS) {
    if (c.arg) assert.ok(sheet.includes(c.arg), `${c.name} lost its argument`);
    assert.ok(sheet.includes(c.desc), `${c.name} lost its description`);
  }
});

test('commands are grouped under their category heading', () => {
  const sheet = cheatSheet(CMDS, LABELS);
  for (const label of Object.values(LABELS)) assert.ok(sheet.includes(label), `${label} missing`);
  assert.ok(sheet.indexOf('CONVERSATION') < sheet.indexOf('/dm'), 'the heading comes first');
});

test('a category with no commands prints no empty heading', () => {
  const sheet = cheatSheet([CMDS[0]!], LABELS);
  assert.ok(sheet.includes('CONVERSATION'));
  assert.ok(!sheet.includes('ADMIN'), 'an empty group would be a heading over nothing');
});

test('🛑 the sheet covers the gestures, which no table can generate', () => {
  const sheet = cheatSheet(CMDS, LABELS);
  for (const section of ['COMPOSER', 'MESSAGES', 'SIDEBAR', 'READING']) {
    assert.ok(sheet.includes(section), `${section} section missing`);
  }
});

test('the gesture lines name the keys and the clicks they describe', () => {
  const sheet = cheatSheet(CMDS, LABELS);
  for (const token of ['Shift-Enter', 'Tab or Enter', 'Esc', 'End', 'Shift-click', 'Kick', 'Delete']) {
    assert.ok(sheet.includes(token), `${token} missing`);
  }
});

test('🛑 the End line carries its caveat, or it is a half-truth', () => {
  // End only jumps while the composer is empty; otherwise it moves the caret.
  const sheet = cheatSheet(CMDS, LABELS);
  const endLine = sheet.indexOf('End');
  assert.ok(sheet.slice(endLine, endLine + 220).includes('composer is empty'));
});

test('the sheet says it is not saved, because nothing else tells you', () => {
  assert.ok(cheatSheet(CMDS, LABELS).includes('not saved'));
});

test('an empty command table still produces the gesture half', () => {
  const sheet = cheatSheet([], LABELS);
  assert.ok(sheet.includes('COMPOSER'));
  assert.ok(!sheet.includes('CONVERSATION'), 'no headings without commands');
});

// ── "@" file path hints ─────────────────────────────────────────────────

const HINTS = [
  { value: '@src/', kind: 'dir' as const },
  { value: '@setup.ts', kind: 'file' as const },
];
const pathAccept = (value: string, caret: number, hints = HINTS) => {
  const s = pathSuggestionsFor(hints, value, caret);

  return s && { items: s.items.map((i) => ({ insert: i.insert, caret: i.caret, reopen: i.reopen })), typed: s.typed };
};

test('🛑 "@" is for PATHS and "#" is for NAMES. Neither answers the other.', () => {
  assert.equal(atTokenAt('see #src', 8), null, 'a # token is not a path token');
  assert.notEqual(atTokenAt('see @src', 8), null);
});

test('🛑 an email address does not open the file list', () => {
  assert.equal(atTokenAt('a@b.com', 7), null, 'the @ must OPEN a word');
  assert.equal(atTokenAt('mail lee@here', 13), null);
});

test('a slash line is a command line, so "@" stays inert there', () => {
  assert.equal(atTokenAt('/dm @src', 8), null);
});

test('a path token keeps slashes, dots and a leading tilde', () => {
  assert.deepEqual(atTokenAt('@~/dev/le', 9), { query: '~/dev/le', start: 0, end: 9 });
  assert.deepEqual(atTokenAt('@web/assets/a.js', 16), { query: 'web/assets/a.js', start: 0, end: 16 });
});

test('the token runs to the end of the word, so accepting leaves no orphan', () => {
  assert.equal(pathAccept('see @s now', 6)!.items[0]!.insert, 'see @src/ now');
});

test('🛑 a DIRECTORY reopens the list and gets NO trailing space', () => {
  // Without this you cannot drill past the first level.
  const dir = pathAccept('see @s', 6)!.items[0]!;
  assert.equal(dir.insert, 'see @src/');
  assert.equal(dir.reopen, true);
});

test('🛑 a FILE does not reopen, and DOES get a trailing space', () => {
  const file = pathAccept('see @s', 6)!.items[1]!;
  assert.equal(file.insert, 'see @setup.ts ');
  assert.equal(file.reopen, false, 'reopening on a finished file is the /help stuck bug');
});

test('completing before an existing space does not leave two', () => {
  const file = pathAccept('see @s now', 6)!.items[1]!;
  assert.equal(file.insert, 'see @setup.ts now');
  assert.ok(!file.insert.includes('  '));
});

test('the caret lands after the inserted path', () => {
  const dir = pathAccept('see @s now', 6)!.items[0]!;
  assert.equal(dir.insert.slice(0, dir.caret), 'see @src/');
});

test('no hints means no popover, rather than an empty one', () => {
  assert.equal(pathSuggestionsFor([], 'see @zzz', 8), null);
});

test('a hint already carries its own directory, so a nested accept is not doubled', () => {
  const nested = [{ value: '@web/assets/logic.js', kind: 'file' as const }];
  assert.equal(pathAccept('see @web/assets/lo', 18, nested)!.items[0]!.insert, 'see @web/assets/logic.js ');
});

test('🛑 Enter SENDS once the line already equals the top hint, so it never sticks', () => {
  // A path keeps the WHOLE-VALUE rule, unlike a mention. The insert carries
  // no trailing space for a directory, so it can equal the value exactly.
  const s = pathSuggestionsFor(HINTS, 'see @src/', 9)!;
  assert.equal(s.items[0]!.insert, 'see @src/', 'accepting would change nothing');
  assert.equal(enterShouldSend(s, 'see @src/'), true, 'so Enter must send, not re-accept');
});

test('Enter ACCEPTS while the path is still half-typed', () => {
  assert.equal(enterShouldSend(pathSuggestionsFor(HINTS, 'see @s', 6)!, 'see @s'), false);
});

test('Tab is what drills into a directory, and it reopens to show the next level', () => {
  const dir = pathSuggestionsFor(HINTS, 'see @src/', 9)!.items[0]!;
  assert.equal(dir.reopen, true, 'Enter sends, Tab keeps going');
});

// ── a dropped file's path ───────────────────────────────────────────────

const ROOTS = { cwd: '/Users/lee/dev/proj', home: '/Users/lee' };

/**
 * 🛑 THE FILE LIST CANNOT ANSWER THIS, which is the whole reason this
 * function exists. `DataTransfer.files` yields `File` objects and a `File`
 * exposes `.name` and no path — a browser privacy boundary. The path is in
 * `text/uri-list` or it is nowhere.
 */
test('a file: URL yields its decoded path', () => {
  assert.deepEqual(pathsFromUriList('file:///Users/lee/a.ts'), ['/Users/lee/a.ts']);
});

test('a percent-escaped space is decoded, because real paths have spaces', () => {
  assert.deepEqual(pathsFromUriList('file:///Users/lee/a%20b.ts'), ['/Users/lee/a b.ts']);
});

test('several lines give several paths, in order', () => {
  assert.deepEqual(pathsFromUriList('file:///a\r\nfile:///b'), ['/a', '/b']);
});

/**
 * ⚠️ RFC 2483 comments are skipped by the file: test, not by a rule of their
 * own. A line cannot open with both "#" and "file://", so a dedicated
 * comment filter is unreachable — one was written, no mutant could kill it,
 * and it was deleted.
 */
test('a comment line and a blank line are skipped', () => {
  assert.deepEqual(pathsFromUriList('# a comment\n\nfile:///a'), ['/a']);
  assert.deepEqual(pathsFromUriList('#file:///looks-like-one\nfile:///a'), ['/a']);
});

test('🛑 a drag from a BROWSER carries no path and yields nothing', () => {
  assert.deepEqual(pathsFromUriList('https://example.com/x.ts'), []);
  assert.deepEqual(pathsFromUriList(''), []);
});

test('"file://localhost/a" is this machine and means "/a"', () => {
  assert.deepEqual(pathsFromUriList('file://localhost/a'), ['/a']);
});

/** 🛑 A REMOTE host is NOT a local path, and inserting it as one would lie. */
test('file://server/share is refused rather than turned into a local path', () => {
  assert.deepEqual(pathsFromUriList('file://server/share'), []);
});

test('a malformed percent-escape is dropped, not inserted mangled', () => {
  assert.deepEqual(pathsFromUriList('file:///a%ZZ'), []);
});

// ── what it becomes in the composer ─────────────────────────────────────

test('a file in the project folder becomes a relative path', () => {
  assert.equal(droppedPathValue('/Users/lee/dev/proj/src/x.ts', ROOTS), 'src/x.ts');
});

test('a file under home but outside the project gets "~/"', () => {
  assert.equal(droppedPathValue('/Users/lee/notes.md', ROOTS), '~/notes.md');
});

test('a file under neither root keeps its absolute path', () => {
  assert.equal(droppedPathValue('/etc/hosts', ROOTS), '/etc/hosts');
});

/**
 * 🛑 THE ORDER IS LOAD-BEARING AND THIS IS THE TEST THAT PINS IT.
 *
 * The project folder sits INSIDE home, so testing home first turns every
 * project file into "~/dev/proj/..." and the drop disagrees with what the
 * "@" hints insert for the very same file.
 */
test('🛑 the project folder wins over home, because it is INSIDE home', () => {
  assert.equal(droppedPathValue('/Users/lee/dev/proj/a.ts', ROOTS), 'a.ts');
  assert.notEqual(droppedPathValue('/Users/lee/dev/proj/a.ts', ROOTS), '~/dev/proj/a.ts');
});

/** 🛑 A string prefix is not containment — the trailing slash is the guard. */
test('a sibling folder sharing a prefix is NOT treated as inside', () => {
  assert.equal(droppedPathValue('/Users/lee/dev/proj-other/z.ts', ROOTS), '~/dev/proj-other/z.ts');
});

test('the roots themselves resolve to "." and "~"', () => {
  assert.equal(droppedPathValue('/Users/lee/dev/proj', ROOTS), '.');
  assert.equal(droppedPathValue('/Users/lee', ROOTS), '~');
});

test('a trailing slash on a root does not produce a leading slash', () => {
  assert.equal(droppedPathValue('/Users/lee/dev/proj/x', { cwd: '/Users/lee/dev/proj/', home: '/Users/lee' }), 'x');
});

/** ⚠️ With no roots yet, an absolute path is still better than nothing. */
test('with empty roots the absolute path is inserted unchanged', () => {
  assert.equal(droppedPathValue('/a/b.ts', { cwd: '', home: '' }), '/a/b.ts');
});

test('several files insert as one space-separated line', () => {
  assert.equal(
    dropInsertText(['/Users/lee/dev/proj/a.ts', '/Users/lee/n.md', '/etc/hosts'], ROOTS),
    'a.ts ~/n.md /etc/hosts',
  );
});

/**
 * 🛑 lee's OWN CASE, verbatim. A real Finder drag of this file carried no
 * `text/uri-list`, so the composer stayed empty and a warning fired. The name
 * is all the browser gives, so the name is what gets inserted.
 */
test('🚨 a dropped name with spaces is inserted, quoted', () => {
  assert.equal(
    dropNameText(['Screenshot 2026-10-20 at 7.15.09 PM.png']),
    '"Screenshot 2026-10-20 at 7.15.09 PM.png"',
  );
});

test('a name with no space is inserted bare', () => {
  assert.equal(dropNameText(['notes.md']), 'notes.md');
});

/**
 * ⚠️ THE QUOTING IS WHAT KEEPS TWO NAMES SEPARABLE. Unquoted, "a b.png c.png"
 * could be two files or three.
 */
test('🚨 several names stay separable, each quoted only if it needs it', () => {
  assert.equal(dropNameText(['a b.png', 'c.png']), '"a b.png" c.png');
});

test('no names produces an empty string rather than a stray quote', () => {
  assert.equal(dropNameText([]), '');
});

/** A tab counts as whitespace, so it must trigger the quoting too. */
test('a name containing a tab is quoted', () => {
  assert.equal(dropNameText(['a\tb.png']), '"a\tb.png"');
});

/**
 * 🛑 A FILENAME MAY CONTAIN A DOUBLE QUOTE. `touch 'two "q" .png'` succeeds on
 * macOS, verified. Quoting without escaping closes the token early and the
 * pair becomes unreadable. Raised by claude1 reviewing 3c044cf.
 */
test('🚨 an embedded quote is escaped, so the pair stays readable', () => {
  assert.equal(dropNameText(['two "q" .png', 'plain.png']), '"two \\"q\\" .png" plain.png');
});

/** A quote with no space still needs the quoting, or the escape has no fence. */
test('🚨 a name with a quote but no space is quoted too', () => {
  assert.equal(dropNameText(['a"b.png']), '"a\\"b.png"');
});

/**
 * 🛑 lee's OWN CASE. Every macOS screenshot is "Screenshot <date> at <time>",
 * so the space lands right after the first word anyone types. The popover
 * closed on it, which made "keep typing to narrow" unfollowable on exactly
 * the files the 30-item cap hides.
 */
test('🚨 a space inside a PATH keeps the token alive', () => {
  const v = '@~/Desktop/Screenshot 2026-11-01';
  assert.deepEqual(atTokenAt(v, v.length), {
    query: '~/Desktop/Screenshot 2026-11-01',
    start: 0,
    end: v.length,
  });
});

/**
 * 🛑 THE NEGATIVE CONTROL, AND IT IS THE WHOLE SAFETY ARGUMENT. Without the
 * "/" precondition this becomes one token and every mention breaks.
 */
test('🚨 a space after a HANDLE still ends the token', () => {
  assert.equal(atTokenAt('@claude1 are you there', 22), null);
  assert.equal(atTokenAt('@claude1 are', 12), null);
});

test('🚨 a bare word with no slash does not swallow the next word', () => {
  assert.equal(atTokenAt('@src more words', 15), null);
});

/**
 * 🛑 THE "/" MUST ARRIVE BEFORE THE FIRST SPACE. An earlier cut searched the
 * whole typed string, so a mention qualified on a slash four words later and
 * swallowed the sentence behind it. Found by claude1, and the previous guard
 * could not see it — `@claude1 are you there` has no slash anywhere.
 */
test('🚨 a mention followed by a path does NOT become one token', () => {
  assert.equal(atTokenAt('@claude1 look in src/foo', 24), null);
  assert.equal(atTokenAt('@claude1 see web/assets/app.js please', 37), null);
});

/**
 * ⚠️ A PATH FOLLOWED BY PROSE IS THE RESIDUAL, and it is bounded rather than
 * fixed. Text alone cannot tell "a space inside a filename" from "a space
 * ending a path" while it is still being typed. The damage stops at the hint
 * lookup: no entry starts with a space, so nothing is offered and Tab is inert.
 */
test('🚨 a path then prose yields NO suggestions, so Tab cannot rewrite the line', () => {
  const v = '@src/ more words';
  assert.notEqual(atTokenAt(v, v.length), null, 'the token does extend — this is the residual');
  assert.equal(pathSuggestionsFor([], v, v.length), null, 'and it offers nothing');
});

test('several spaces inside one path are all kept', () => {
  const v = '@~/a b/c d e.png';
  assert.equal(atTokenAt(v, v.length)!.query, '~/a b/c d e.png');
});

/** The caret is the end, so text after it is left alone. */
test('🚨 the token ends at the CARET, so a trailing word survives an accept', () => {
  const v = '@~/Desktop/Screen shot.png and more';
  const t = atTokenAt(v, 26)!;
  assert.equal(t.query, '~/Desktop/Screen shot.png');
  assert.equal(t.end, 26, 'the tail is not swallowed');
});

/** A path typed before a newline must not reach across it. */
test('a newline is not a path space', () => {
  assert.equal(atTokenAt('@~/a\nb', 6), null);
});


// ── /clear — chat-mcp#88 ──────────────────────────────────────────────────

/**
 * 🛑 THE CONTRACT RULE THESE EXIST TO PIN: `cleared` may be 0, and 0 is a
 * SUCCESS. `deleteRoomMessages` and `deleteDmMessages` return a row count, so
 * neither can tell an empty room from a missing one. A client that branches on
 * falsiness reports a failure that did not happen.
 */
test('🚨 a cleared count of 0 reads as success, not as a failure', () => {
  const room = clearResultText(0, '#gate');
  assert.match(room, /already empty/);
  assert.doesNotMatch(room, /fail|error|could not/i);

  const dm = clearResultText(0, 'claude2');
  assert.match(dm, /already empty/);
  assert.doesNotMatch(dm, /fail|error|could not/i);
});

test('the count and its plural are both in the result text', () => {
  assert.equal(clearResultText(1, '#gate'), 'cleared 1 message from #gate');
  assert.equal(clearResultText(7, '#gate'), 'cleared 7 messages from #gate');
});

/** A room is `from`, a DM is `with`. The preposition is the only tell. */
test('a DM result names the peer, not a room', () => {
  assert.equal(clearResultText(2, 'claude2'), 'cleared 2 messages with claude2');
});

/**
 * The confirm text must state the blast radius, because the web UI reaches
 * this in one click where the CLI makes you type it.
 */
test('the room confirm says EVERYONE and that the room survives', () => {
  const t = clearConfirmText('#gate');
  assert.match(t, /^Clear #gate\?/);
  assert.match(t, /EVERYONE/);
  assert.match(t, /room and its memberships stay/);
  assert.match(t, /cannot be undone/);
});

test('the DM confirm says BOTH of you and never says EVERYONE', () => {
  const t = clearConfirmText('claude2');
  assert.match(t, /^Clear your conversation with claude2\?/);
  assert.match(t, /BOTH of you/);
  assert.doesNotMatch(t, /EVERYONE/);
  assert.match(t, /cannot be undone/);
});

/**
 * Both DM directions are deleted — `deleteDmMessages` matches (a,b) OR (b,a) —
 * so claiming only the caller loses them would be false.
 */
test('the DM confirm does not promise a one-sided delete', () => {
  assert.doesNotMatch(clearConfirmText('claude2'), /only (for )?you|your copy/i);
});

// ---------------------------------------------------------------------------
// #92 — the conversation style selector
// ---------------------------------------------------------------------------

test('choosing a preset saves it', () => {
  assert.deepEqual(styleSelection('succinct', null), { action: 'save', style: 'succinct' });
});

test('choosing none clears it, which is null and not an empty string', () => {
  assert.deepEqual(styleSelection('', 'succinct'), { action: 'save', style: null });
});

/**
 * 🛑 `custom` IS REFUSED, NOT SAVED. The server demands markdown with it and a
 * header select has nowhere to type multi-line markdown, so offering it and
 * failing would be worse than refusing. The option stays in the list because a
 * room CAN be in that state via the set_style tool.
 */
test('choosing custom refuses and reverts to what the room already had', () => {
  const decision = styleSelection('custom', 'normal');

  assert.equal(decision.action, 'refuse');
  assert.equal(decision.revertTo, 'normal');
  assert.match(decision.message, /set_style/);
});

test('refusing custom on an unstyled room reverts to none, not undefined', () => {
  assert.equal(styleSelection('custom', null).revertTo, '');
});
