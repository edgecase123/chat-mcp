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

test('🛑 the shimmer is visible in the LIGHT theme, where lee could not see it', () => {
  const delta = peakDelta(':root');

  assert.ok(delta >= MIN_DELTA, `light peak delta ${delta} is below the ${MIN_DELTA} floor`);
});

test('🛑 the shimmer is visible in the DARK theme too — it has its own accent and bg', () => {
  const delta = peakDelta('[data-theme="dark"]');

  assert.ok(delta >= MIN_DELTA, `dark peak delta ${delta} is below the ${MIN_DELTA} floor`);
});

test('⚠️ control — the OLD 16% tint fails this floor in both themes', () => {
  // Proves the floor discriminates. A floor every value passes is no floor.
  const old = (accentHex: string, bgHex: string) => {
    const accent = rgb(accentHex);
    const bg = rgb(bgHex);

    return Math.max(...accent.map((c, i) => Math.abs(Math.round(0.16 * c + 0.84 * bg[i]!) - bg[i]!)));
  };

  assert.ok(old(token(':root', 'accent'), token(':root', 'bg')) < MIN_DELTA);
  assert.ok(old(token('[data-theme="dark"]', 'accent'), token('[data-theme="dark"]', 'bg')) < MIN_DELTA);
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
