/**
 * Reading theme tokens out of `web/assets/style.css` as TEXT.
 *
 * ⚠️ THERE IS NO DOM UNDER `node --test`, so nothing here resolves a cascade.
 * These helpers read the token blocks they name and fail loudly if one stops
 * existing, which is the useful half for a colour floor.
 *
 * Shared by the shimmer and the search-highlight floors — the second copy of
 * `block`/`token`/`rgb` is what moved them here.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

export const CSS = readFileSync(new URL('../../web/assets/style.css', import.meta.url), 'utf8');

/** The body of a top-level rule, by its exact selector. */
export function block(selector: string): string {
  const start = CSS.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `selector ${selector} is gone from style.css`);
  const end = CSS.indexOf('\n}', start);
  assert.notEqual(end, -1, `selector ${selector} has no closing brace`);

  return CSS.slice(start, end);
}

export function token(selector: string, name: string): string {
  const m = new RegExp(`--${name}:\\s*([^;]+);`).exec(block(selector));
  assert.ok(m, `--${name} is gone from ${selector}`);

  return m[1]!.trim();
}

export function rgb(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  assert.ok(m, `expected a 6-digit hex colour, got ${hex}`);

  return [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)];
}

/**
 * The denominator, asserted by every caller. `:root` plus one `data-theme`
 * block is the minimum this stylesheet has ever had, so a regex that silently
 * stops matching fails instead of reporting a clean sweep over nothing.
 */
export const MIN_THEMES = 2;

/**
 * Every theme block in the stylesheet, DISCOVERED rather than listed.
 *
 * 🛑 A HAND-WRITTEN PAIR LETS A THIRD THEME SHIP INVISIBLE AND GREEN. The
 * stylesheet's header says adding a theme is drop-in — define a property block
 * and let the toggle set `data-theme`. Raised by claude1 on PR 119.
 *
 * The selector is anchored at a line start and followed by the brace, so
 * `[data-theme="dark"] .theme-icon::before` is not mistaken for the block.
 */
export function themeSelectors(): string[] {
  const found = [...new Set([...CSS.matchAll(/^(:root|\[data-theme="[a-z-]+"\])\s*\{/gm)].map((m) => m[1]!))];

  // 🛑 THE DENOMINATOR LIVES HERE, NOT IN ONE TEST. Asserted in a dedicated
  // test only, it was not inherited: breaking this regex left 5 of 6 floors
  // GREEN, including both controls, because `.filter()` on `[]` then
  // `deepEqual([], [])` passes. A control that cannot fail is not a control.
  // Raised by claude1 on PR 120 — the same fix I talked them into for
  // `appCssViews()` on leagues #2439.
  assert.ok(
    found.length >= MIN_THEMES,
    `found ${found.length} theme blocks, expected at least ${MIN_THEMES}: ${found.join(', ') || '(none)'}`,
  );

  return found;
}


/** The largest per-channel distance between two opaque colours. */
export function channelDistance(a: string, b: string): number {
  const [A, B] = [rgb(a), rgb(b)];

  return Math.max(...A.map((c, i) => Math.abs(c - B[i]!)));
}

/** WCAG 2.1 relative luminance. */
function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((v) => {
    const s = v / 255;

    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];

  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.1 contrast ratio. 4.5 is the AA floor for body-sized text. */
export function contrastRatio(a: string, b: string): number {
  const [la, lb] = [luminance(a), luminance(b)];

  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
