import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MIN_THEMES, block, rgb, themeSelectors, token } from '../support/theme-tokens.js';

/**
 * The largest per-channel distance between the shimmer's peak and the page.
 *
 * ⚠️ THE TINT IS READ FROM `:root` FOR EVERY THEME, BY DESIGN. It has one home
 * and a theme block overrides only the tokens it names, so a text parser that
 * demanded it per block would fail on the cascade rather than on a defect.
 */
function peakDelta(selector: string): number {
  const pct = token(':root', 'msg-fresh-tint');
  const m = /^(\d+(?:\.\d+)?)%$/.exec(pct);
  assert.ok(m, `--msg-fresh-tint must be a percentage, got ${pct}`);
  const alpha = Number(m[1]) / 100;

  const accent = rgb(token(selector, 'accent'));
  const bg = rgb(token(selector, 'bg'));

  // color-mix(accent N%, transparent) over --bg is a plain source-over blend.
  return Math.max(...accent.map((c, i) => Math.abs(Math.round(alpha * c + (1 - alpha) * bg[i]!) - bg[i]!)));
}

/**
 * 60/255 is the floor, chosen as comfortably above the 40 that lee could not
 * see and below the 99 the current tokens give. It is a REGRESSION floor, not
 * a target — it exists so lowering the tint back to invisible fails here.
 */
const MIN_DELTA = 60;

test('🛑 the sweep found every theme block — the denominator, not just the result', () => {
  const selectors = themeSelectors();

  assert.ok(
    selectors.length >= MIN_THEMES,
    `found ${selectors.length} theme blocks, expected at least ${MIN_THEMES}: ${selectors.join(', ')}`,
  );
  // `:root` carries the tint and is the light theme, so it must be among them.
  assert.ok(selectors.includes(':root'), `:root is missing from ${selectors.join(', ')}`);
});

test('🛑 the shimmer is visible in EVERY theme, including any added later', () => {
  const failures = themeSelectors()
    .map((selector) => ({ selector, delta: peakDelta(selector) }))
    .filter(({ delta }) => delta < MIN_DELTA);

  assert.deepEqual(
    failures,
    [],
    `these themes are below the ${MIN_DELTA} floor: ${failures.map((f) => `${f.selector} at ${f.delta}`).join(', ')}`,
  );
});

test('⚠️ control — the OLD 16% tint fails this floor in EVERY theme', () => {
  // Proves the floor discriminates. A floor every value passes is no floor.
  const atOldTint = (selector: string) => {
    const accent = rgb(token(selector, 'accent'));
    const bg = rgb(token(selector, 'bg'));

    return Math.max(...accent.map((c, i) => Math.abs(Math.round(0.16 * c + 0.84 * bg[i]!) - bg[i]!)));
  };

  const passing = themeSelectors().filter((s) => atOldTint(s) >= MIN_DELTA);

  assert.deepEqual(passing, [], `the old 16% tint should fail everywhere, but passed in ${passing.join(', ')}`);
});

test('🛑 the shimmer gradient reads the TOKEN, not a hard-coded percentage', () => {
  // ⚠️ SCOPED TO THE SHIMMER RULE. An unscoped `doesNotMatch` over the whole
  // stylesheet failed on an unrelated 7% accent mix elsewhere — a true hit
  // about a rule this test does not govern.
  const rule = block('.message.is-fresh::after');

  assert.match(rule, /color-mix\(in srgb, var\(--accent\) var\(--msg-fresh-tint\), transparent\)/);
  assert.doesNotMatch(rule, /color-mix\(in srgb, var\(--accent\) \d/);
});

test('the duration is long enough that the sweep is not a flash', () => {
  const raw = token(':root', 'msg-fresh-ms');
  const ms = Number.parseInt(raw, 10);

  assert.ok(Number.isFinite(ms), `--msg-fresh-ms must parse as ms, got ${raw}`);
  // app.js strips `.is-fresh` at this value plus 60ms, so it bounds the sweep.
  assert.ok(ms >= 600, `${ms}ms is too short for the sweep to register`);
});
