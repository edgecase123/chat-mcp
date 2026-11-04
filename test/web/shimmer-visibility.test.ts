import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * 🛑 THE SHIMMER FIRED THE WHOLE TIME AND WAS TOO FAINT TO SEE.
 *
 * lee reported it as not working for new messages. A MutationObserver on the
 * live UI caught the arriving row carrying `.is-fresh`, so the logic was right
 * and the token was not: at 16% of `--accent` the peak sat at rgb(215,237,243)
 * on white, a 40/255 delta, crossing any pixel in roughly an eighth of a
 * second.
 *
 * 🛑 SO THE FLOOR IS ASSERTED, NOT THE VALUE. Pinning `--msg-fresh-tint: 40%`
 * would only restate the stylesheet and would still pass if `--accent` moved
 * to something that vanishes against `--bg`. What matters is the composited
 * distance a reader actually perceives, in BOTH themes.
 *
 * ⚠️ READS THE STYLESHEET AS TEXT. There is no DOM under `node --test`, so this
 * cannot resolve a cascade — it reads the two token blocks it names and fails
 * loudly if either stops existing.
 */

const CSS = readFileSync(new URL('../../web/assets/style.css', import.meta.url), 'utf8');

/** The body of a top-level rule, by its exact selector. */
function block(selector: string): string {
  const start = CSS.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `selector ${selector} is gone from style.css`);
  const end = CSS.indexOf('\n}', start);
  assert.notEqual(end, -1, `selector ${selector} has no closing brace`);

  return CSS.slice(start, end);
}

function token(selector: string, name: string): string {
  const m = new RegExp(`--${name}:\\s*([^;]+);`).exec(block(selector));
  assert.ok(m, `--${name} is gone from ${selector}`);

  return m[1]!.trim();
}

function rgb(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  assert.ok(m, `expected a 6-digit hex colour, got ${hex}`);

  return [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)];
}

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

/**
 * Every theme block in the stylesheet, DISCOVERED rather than listed.
 *
 * 🛑 TWO LITERAL CALLS WOULD LET A THIRD THEME SHIP INVISIBLE AND GREEN. The
 * stylesheet's own header says adding a theme is drop-in — define a property
 * block and let the toggle set `data-theme`. A hand-written pair of
 * assertions covers the two that exist and nothing that arrives. Raised by
 * claude1.
 *
 * The selector is anchored at a line start and followed by the brace, so
 * `[data-theme="dark"] .theme-icon::before` is not mistaken for the block.
 */
function themeSelectors(): string[] {
  const found = [...CSS.matchAll(/^(:root|\[data-theme="[a-z-]+"\])\s*\{/gm)].map((m) => m[1]!);

  return [...new Set(found)];
}

/**
 * The denominator, asserted. `:root` plus one `data-theme` block is the
 * minimum this stylesheet has ever had, so a regex that silently stops
 * matching fails here instead of reporting a clean sweep over nothing.
 */
const MIN_THEMES = 2;

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
