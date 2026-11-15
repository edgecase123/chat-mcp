import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * #240 — the browser half's WIRING, which `activity-pulse.test.ts` cannot see.
 *
 * 🛑 EVERY PURE TEST IN THAT FILE PASSES WITH NO LISTENER WIRED AT ALL. Delete
 * the `activity` listener and all 16 stay green while the dot never moves —
 * the same gap `focus-search-wiring.test.ts` exists to close. There is no DOM
 * here, so the wiring is asserted against the source.
 *
 * ⚠️ EVERY ASSERTION IS GUARDED BY A FOUND-COUNT FIRST. A regex that stops
 * matching after a rename would otherwise report clean by matching nothing.
 */

const APP = readFileSync(new URL('../../web/assets/app.js', import.meta.url), 'utf8');
const CSS = readFileSync(new URL('../../web/assets/style.css', import.meta.url), 'utf8');

/** `app.js` with `//` comments removed, so prose cannot satisfy a code check. */
const APP_CODE = APP.split('\n')
  .filter((line) => !line.trimStart().startsWith('//'))
  .join('\n');

/** The body of the SSE listener that owns the pulse. */
function listenerBody(): string {
  const start = APP_CODE.indexOf("source.addEventListener('activity'");
  assert.notEqual(start, -1, 'no SSE listener for `activity` — the pulse is not wired');

  const end = APP_CODE.indexOf('\n  });', start);
  assert.notEqual(end, -1, 'the activity listener block is unterminated');

  return APP_CODE.slice(start, end);
}

/** The body of `sidebarItem`, which must re-apply the pulse on every rebuild. */
function sidebarItemBody(): string {
  const start = APP_CODE.indexOf('function sidebarItem(');
  assert.notEqual(start, -1, 'sidebarItem is gone or renamed');

  const end = APP_CODE.indexOf('\nfunction ', start + 1);
  assert.notEqual(end, -1, 'sidebarItem is unterminated');

  return APP_CODE.slice(start, end);
}

// ── the listener ─────────────────────────────────────────────────────────

test('🛑 an SSE activity listener parses the frame through the logic module', () => {
  assert.match(listenerBody(), /activityEvent\(e\.data\)/, 'the frame is not parsed by activityEvent');
});

test('🛑 the listener folds the event through the reducer, not by hand', () => {
  assert.match(listenerBody(), /nextPulses\(state\.activity,\s*event\)/);
});

/**
 * 🛑 THE WHOLE REASON THE PULSE IS NOT A RE-RENDER. A tick arrives every 250ms.
 * `renderSidebar` does `el.sidebar.innerHTML = ''`, so routing a pulse through
 * it would rebuild every row four times a second and close an open (...) menu
 * under the operator's cursor on every tool call.
 */
test('🛑 the listener never re-renders the sidebar or refetches', () => {
  const body = listenerBody();

  assert.doesNotMatch(body, /renderSidebar\(/, 'a 250ms pulse must not rebuild the sidebar');
  assert.doesNotMatch(body, /\brefresh\(/, 'a 250ms pulse must not refetch');
});

test('the listener repaints only when the reducer says something changed', () => {
  const body = listenerBody();

  assert.match(body, /!==\s*state\.activity/, 'nothing compares the reducer result by reference');
  assert.match(body, /if \(changed\) paintPulse\(event\.handle\)/);
});

// ── the failsafe ─────────────────────────────────────────────────────────

/** 🛑 lee ruled out polling on this entire path. A tick is what re-arms it. */
test('🛑 the failsafe is a re-armed timeout, never an interval', () => {
  const arm = APP_CODE.indexOf('function armPulseFailsafe(');
  assert.notEqual(arm, -1, 'the failsafe is gone — a dead agent pulses forever');

  const body = APP_CODE.slice(arm, APP_CODE.indexOf('\nfunction ', arm + 1));

  assert.match(body, /setTimeout\(/);
  assert.match(body, /PULSE_FAILSAFE_MS/, 'the duration is hardcoded instead of shared with its test');
  assert.doesNotMatch(body, /setInterval/, 'lee ruled out polling on this path');
});

test('an end event cancels the failsafe rather than leaving it to fire', () => {
  assert.match(listenerBody(), /stopPulseFailsafe\(event\.handle\)/);
});

// ── the rebuild path ─────────────────────────────────────────────────────

/**
 * 🛑 THE BUG THIS PINS IS INVISIBLE AND MID-TURN. `renderSidebar` rebuilds on
 * any peer status change, so if the row does not read `state.activity` the dot
 * is dropped by the next `wake` — while the agent is still working, which is
 * the only moment it matters.
 */
test('🛑 a rebuilt row re-reads the pulse from state', () => {
  const body = sidebarItemBody();

  assert.match(body, /state\.activity\.has\(target\)/, 'a rebuilt row would lose the pulse');
  assert.match(body, /is-working/, 'the rebuilt row carries no working class');
});

test('🛑 the row is addressable, or the handler cannot find it', () => {
  assert.match(sidebarItemBody(), /'data-handle': target/);
  assert.match(APP_CODE, /data-handle="\$\{CSS\.escape\(handle\)\}"/, 'the lookup does not escape the handle');
});

/**
 * 🛑 THE BYPASS MUST NOT REACH A ROOM ROW, AND NOTHING STOPPED IT BUT THIS.
 * `renderSidebar` passes a room NAME as `target`, so every room row carries
 * `data-handle` as well. A pulse naming `#mcp` found that row, added
 * `is-working` and set a title the room dot is specified never to have — until
 * the next rebuild silently undid it, leaving the two paths disagreeing about
 * one row. Scoping the selector makes `kind: 'peer'` true by construction
 * rather than asserted. Found by claude1 on PR 246.
 */
test('🛑 the bypass can only reach a PEER row, by construction', () => {
  assert.match(sidebarItemBody(), /'data-kind': kind/, 'the row does not declare its kind');
  assert.match(
    APP_CODE,
    /\.sidebar__item\[data-kind="peer"\]\[data-handle=/,
    'the lookup is not scoped to peers — a pulse can dress a room row',
  );
});

/**
 * 🛑 AN `end` MUST UNDO WHAT A TICK DID. An early return on a null title left
 * "Working" on the dot of an agent that stopped minutes ago, and only a full
 * rebuild cleared it. The bug arrived with lee's "no title" ruling, which made
 * the non-working title null where it had been a string.
 */
test('🛑 the repaint REMOVES the attributes when the work ends', () => {
  const paint = APP_CODE.indexOf('function paintPulse(');
  assert.notEqual(paint, -1, 'paintPulse is gone');

  const body = APP_CODE.slice(paint, APP_CODE.indexOf('\nfunction ', paint + 1));

  assert.match(body, /removeAttribute/, 'a stale "Working" would survive the turn');
  for (const attr of ['title', 'aria-label', 'role']) {
    assert.ok(body.includes(`'${attr}'`), `${attr} is never cleared`);
  }
});

// ── the non-visual carrier ───────────────────────────────────────────────

/**
 * 🛑 THE DOT CARRIED "ONLINE" IN COLOUR ALONE BEFORE THIS TICKET. Adding a
 * second colour-only state is what makes the title load-bearing rather than
 * polish, and it is why no `prefers-reduced-motion` code path is needed.
 *
 * ⚠️ `role` IS NOT DECORATION HERE. `aria-label` on a bare span is ignored,
 * because a span has no role for the label to name.
 */
test('🛑 the dot states what it means in text, not only in colour', () => {
  const body = sidebarItemBody();

  assert.match(body, /dotTitle\(\{ kind, working \}\)/);
  assert.match(body, /title: dotState/);
  assert.match(body, /'aria-label': dotState/);
  assert.match(body, /role: dotState === null \? null : 'img'/);
});

test('the direct repaint sets the same three attributes as a rebuild', () => {
  const paint = APP_CODE.indexOf('function paintPulse(');
  assert.notEqual(paint, -1, 'paintPulse is gone');

  const body = APP_CODE.slice(paint, APP_CODE.indexOf('\nfunction ', paint + 1));

  assert.match(body, /dotTitle\(/, 'the repaint invents its own wording');
  for (const attr of ['title', 'aria-label', 'role']) {
    assert.match(body, new RegExp(`setAttribute\\('${attr}'`), `the repaint drops ${attr}`);
  }
});

// ── the CSS ──────────────────────────────────────────────────────────────

test('🛑 the animation name resolves to a keyframes block that exists', () => {
  const rule = CSS.match(/\.sidebar__item\.is-working \.sidebar__item-dot \{[^}]*\}/);
  assert.notEqual(rule, null, 'no CSS targets a working dot — the class is inert');

  const name = rule![0].match(/animation:\s*([\w-]+)/);
  assert.notEqual(name, null, 'the working dot has no animation');
  assert.match(CSS, new RegExp(`@keyframes\\s+${name![1]}\\s*\\{`), `@keyframes ${name![1]} is missing`);
});

/**
 * 🛑 WCAG 2.2.2 — MOTION OVER FIVE SECONDS MUST BE STOPPABLE. `dot-pulse` is
 * `infinite` and a turn runs for minutes. The dot's title answers 1.4.1 and I
 * wrongly took it as answering this too. Found by claude1 on PR 246.
 */
test('🛑 the infinite animation is stoppable under reduced motion', () => {
  const blocks = CSS.match(/@media \(prefers-reduced-motion: reduce\) \{[^}]*\}[^}]*\}/g);
  assert.notEqual(blocks, null, 'no reduced-motion block exists at all');

  const covering = blocks!.filter((b) => b.includes('is-working'));
  assert.equal(covering.length, 1, `expected 1 block to reduce the pulse, found ${covering.length}`);
  assert.match(covering[0], /animation:\s*none/);
});

/**
 * ⚠️ A NEGATIVE CONTROL ON THE SELECTOR'S SPECIFICITY. `.is-online` sets the
 * dot's background on the same element, and it appears FIRST in the file, so a
 * working dot that is also online must still win.
 */
test('the working rule is declared after the online rule it overrides', () => {
  const online = CSS.indexOf('.sidebar__item.is-online .sidebar__item-dot');
  const working = CSS.indexOf('.sidebar__item.is-working .sidebar__item-dot');

  assert.notEqual(online, -1);
  assert.notEqual(working, -1);
  assert.ok(working > online, 'the online colour would override the working one');
});
