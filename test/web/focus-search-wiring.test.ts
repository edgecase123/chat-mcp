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
