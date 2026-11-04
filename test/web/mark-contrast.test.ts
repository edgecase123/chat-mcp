import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CSS,
  MIN_THEMES,
  block,
  channelDistance,
  contrastRatio,
  themeSelectors,
  token,
} from '../support/theme-tokens.js';

/**
 * 🛑 A SEARCH HIT HAS TWO JOBS AND THEY PULL AGAINST EACH OTHER.
 *
 * It must stand out from the page, and the marked word must stay readable. The
 * old `--accent-soft` mark was legible and almost invisible: 48 of 255 from
 * white. lee asked for it louder.
 *
 * 🛑 FULL-STRENGTH `--accent` IS THE TRAP. It is the loudest option by raw
 * distance — 247 — and gives white-on-cyan at 3.68:1, BELOW the 4.5 AA floor.
 * A found word would read worse than the text around it. So both floors are
 * asserted, not just the loud one.
 */

/** Below this, the mark does not announce itself. The old value scored 48. */
const MIN_POP = 120;

/** WCAG 2.1 AA for body-sized text. The mark is body-sized. */
const MIN_CONTRAST = 4.5;

function markOn(selector: string) {
  return {
    pop: channelDistance(token(selector, 'mark-bg'), token(selector, 'bg')),
    contrast: contrastRatio(token(selector, 'mark-bg'), token(selector, 'mark-fg')),
  };
}

test('🛑 the sweep found every theme block — the denominator, not just the result', () => {
  const selectors = themeSelectors();

  assert.ok(
    selectors.length >= MIN_THEMES,
    `found ${selectors.length} theme blocks, expected at least ${MIN_THEMES}: ${selectors.join(', ')}`,
  );
  assert.ok(selectors.includes(':root'), `:root is missing from ${selectors.join(', ')}`);
});

test('🛑 the mark STANDS OUT from the page, in every theme', () => {
  const quiet = themeSelectors()
    .map((selector) => ({ selector, ...markOn(selector) }))
    .filter(({ pop }) => pop < MIN_POP);

  assert.deepEqual(quiet, [], `below the ${MIN_POP} pop floor: ${quiet.map((q) => `${q.selector} at ${q.pop}`).join(', ')}`);
});

test('🛑 the marked word stays READABLE, in every theme', () => {
  const unreadable = themeSelectors()
    .map((selector) => ({ selector, ...markOn(selector) }))
    .filter(({ contrast }) => contrast < MIN_CONTRAST);

  assert.deepEqual(
    unreadable,
    [],
    `below AA: ${unreadable.map((u) => `${u.selector} at ${u.contrast.toFixed(2)}`).join(', ')}`,
  );
});

test('⚠️ control — the OLD --accent-soft mark fails the pop floor everywhere', () => {
  // Proves the pop floor discriminates. A floor every value passes is no floor.
  const passing = themeSelectors().filter(
    (s) => channelDistance(token(s, 'accent-soft'), token(s, 'bg')) >= MIN_POP,
  );

  assert.deepEqual(passing, [], `the old mark should be too quiet everywhere, but passed in ${passing.join(', ')}`);
});

test('⚠️ control — full-strength --accent fails the CONTRAST floor in light mode', () => {
  // The loudest option, and the reason loudness alone is not the test. Uses
  // --accent-fg because that is the text any accent-background element gets.
  const light = contrastRatio(token(':root', 'accent'), token(':root', 'accent-fg'));

  assert.ok(light < MIN_CONTRAST, `white-on-accent scored ${light.toFixed(2)}, which no longer fails AA`);
});

test('🛑 the mark reads its OWN colour, never inheriting the body text', () => {
  // ⚠️ SCOPED TO THE MARK RULE. An unscoped search would hit every other
  // `color: inherit` in the stylesheet, which this test does not govern.
  const rule = block('.message__body mark');

  assert.match(rule, /background: var\(--mark-bg\)/);
  assert.match(rule, /color: var\(--mark-fg\)/);
  // `--fg` flips per theme and an amber ground does not, so inheriting it
  // would give light text on amber in exactly one theme.
  assert.doesNotMatch(rule, /color:\s*inherit/);
});

test('the mark tokens are defined in every theme, not only the first', () => {
  // A token missing from a theme block falls back through the cascade to the
  // light value, which is the shape that makes one theme silently wrong.
  for (const selector of themeSelectors()) {
    assert.match(token(selector, 'mark-bg'), /^#[0-9a-f]{6}$/i, `${selector} --mark-bg`);
    assert.match(token(selector, 'mark-fg'), /^#[0-9a-f]{6}$/i, `${selector} --mark-fg`);
  }
  assert.ok(CSS.includes('--mark-bg'), 'the token vanished entirely');
});
