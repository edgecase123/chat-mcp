import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * 🛑 `roomMetaLabel`'s OWN TESTS PASS WITH THE RENDER WIRING BROKEN.
 *
 * It is a pure function, so `logic.test.ts` proves only that the string is
 * right. Replace the call in `renderPaneHeader` with the old inline member
 * count and every one of those tests still goes green while no surface shows
 * an owner — which is the exact defect #89 was filed about. Measured: that
 * mutant killed 0 of 235 before this file existed.
 *
 * There is no DOM harness for `app.js` here, so the wiring is asserted against
 * the source text.
 */

const APP = readFileSync(new URL('../../web/assets/app.js', import.meta.url), 'utf8');

/** `app.js` with `//` comments removed, so prose cannot satisfy a code check. */
const APP_CODE = APP.split('\n')
  .filter((line) => !line.trimStart().startsWith('//'))
  .join('\n');

test('🛑 the ROOM branch of the pane meta line goes through roomMetaLabel', () => {
  const found = APP_CODE.match(/el\.paneMeta\.textContent = .*/g);

  // ⚠️ THE DENOMINATOR. No match means the regex stopped working, and then
  // every claim below is about an empty list.
  assert.notEqual(found, null, 'nothing assigns the pane meta line');
  assert.ok(found!.length >= 3, `only ${found!.length} pane meta assignments found; the regex has drifted`);

  // 🛑 NOT "every assignment must use the helper". Four exist, and two are
  // the empty state and a DM's online/offline line. Those are not rooms and
  // must not be dragged through a room helper. The first draft of this test
  // asserted that and failed on a clean tree.
  const viaHelper = found!.filter((l) => /roomMetaLabel\(/.test(l));

  assert.equal(viaHelper.length, 1, `expected exactly one helper call, got ${viaHelper.length}`);
});

test('🛑 THE MEMBER COUNT IS NOT FORMATTED ANYWHERE IN app.js', () => {
  // The inline `${room.member_count ?? '?'} members` this replaced. A second
  // copy is free to drift from the helper, and the helper is what is tested.
  // Together with the test above this pins the ROOM branch specifically:
  // the only way to render a count is to call the helper.
  assert.doesNotMatch(APP_CODE, /member_count/, 'app.js formats a member count itself');
});
