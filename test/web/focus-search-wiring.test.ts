import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * 🛑 THE PREDICATE'S OWN TESTS PASS WITH NO HANDLER WIRED AT ALL.
 *
 * `focusSearchKeyApplies` is pure, so `logic.test.ts` proves only that the
 * decision is right. Delete the `keydown` listener in `app.js` and every one of
 * those tests still goes green while the shortcut does nothing. There is no DOM
 * here to press a key against, so the wiring is asserted against the source.
 *
 * ⚠️ EVERY ASSERTION BELOW IS GUARDED BY A FOUND-COUNT FIRST. A regex that
 * stops matching after a rename would otherwise report "clean" by matching
 * nothing, which is the failure this file exists to catch.
 */

const APP = readFileSync(new URL('../../web/assets/app.js', import.meta.url), 'utf8');

/** `app.js` with `//` comments removed, so prose cannot satisfy a code check. */
const APP_CODE = APP.split('\n')
  .filter((line) => !line.trimStart().startsWith('//'))
  .join('\n');

/** The body of the `keydown` listener that owns the shortcut. */
function handlerBody(): string {
  const start = APP_CODE.indexOf('focusSearchKeyApplies(e,');
  assert.notEqual(start, -1, 'no keydown handler calls focusSearchKeyApplies — the shortcut is not wired');

  const open = APP_CODE.lastIndexOf('document.addEventListener(\'keydown\'', start);
  assert.notEqual(open, -1, 'focusSearchKeyApplies is called outside a document keydown listener');

  const end = APP_CODE.indexOf('\n});', start);
  assert.notEqual(end, -1, 'the handler block is unterminated');

  return APP_CODE.slice(open, end);
}

test('🛑 a document keydown handler calls the predicate', () => {
  const body = handlerBody();

  assert.match(body, /focusSearchKeyApplies\(e,\s*IS_MAC\)/, 'the platform flag is not passed');
});

test('🛑 the handler suppresses the browser find-in-page', () => {
  // Without this the box focuses AND Chrome's find bar opens over it, so the
  // next keystroke goes to whichever one won the race.
  assert.match(handlerBody(), /preventDefault\(\)/);
});

test('the handler focuses the filter box and selects what is in it', () => {
  const body = handlerBody();

  assert.match(body, /el\.paneSearch\.focus\(\)/, 'focus');
  // A second press must replace the term rather than append to it.
  assert.match(body, /el\.paneSearch\.select\(\)/, 'select');
});

test('IS_MAC is derived from the platform, not hardcoded', () => {
  const found = APP_CODE.match(/const IS_MAC = .*/);

  assert.notEqual(found, null, 'IS_MAC is not declared');
  assert.match(found![0], /navigator\./, `IS_MAC does not read navigator: ${found![0]}`);
});

const HTML = readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8');

test('🛑 app.js OVERWRITES the placeholder from the same platform flag', () => {
  // The markup is served to every platform, so a combo in the HTML would be
  // wrong for half of the readers. `searchPlaceholder` must read `IS_MAC`, the
  // same flag the binding reads, or the box can advertise a dead key.
  const found = APP_CODE.match(/el\.paneSearch\.placeholder = .*/);

  assert.notEqual(found, null, 'nothing sets the placeholder at boot');
  assert.match(found![0], /searchPlaceholder\(IS_MAC\)/, found![0]);
});

test('🛑 THE STATIC PLACEHOLDER NAMES NO COMBO', () => {
  // It is the no-JS fallback. A combo baked here is wrong on one platform and
  // can never be corrected, because nothing re-reads the attribute.
  const found = HTML.match(/id="pane-search"[\s\S]{0,200}?placeholder="([^"]*)"/);

  assert.notEqual(found, null, 'the filter box has no placeholder attribute');
  assert.doesNotMatch(found![1], /Cmd|Ctrl|⌘|-F\b/, `the static fallback hardcodes a combo: ${found![1]}`);
});

test('🛑 app.js OVERWRITES THE ACCESSIBLE NAME TOO, from the same flag', () => {
  // `aria-label` wins over `placeholder`, so setting only the placeholder
  // leaves a screen-reader user never told the key exists.
  const found = APP_CODE.match(/el\.paneSearch\.ariaLabel = .*/);

  assert.notEqual(found, null, 'nothing sets the accessible name at boot');
  assert.match(found![0], /searchAriaLabel\(IS_MAC\)/, found![0]);
});

test('🛑 THE STATIC aria-label NAMES NO COMBO EITHER', () => {
  // Same reason as the placeholder: served to every platform, never re-read.
  const found = HTML.match(/id="pane-search"[\s\S]{0,300}?aria-label="([^"]*)"/);

  assert.notEqual(found, null, 'the filter box has no aria-label attribute');
  assert.doesNotMatch(found![1], /Cmd|Ctrl|⌘|-F\b/, `the static fallback hardcodes a combo: ${found![1]}`);
});
