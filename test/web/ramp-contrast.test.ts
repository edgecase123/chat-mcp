import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CSS,
  MIN_THEMES,
  block,
  channelDistance,
  contrastRatio,
  themeSelectors,
  token,
} from "../support/theme-tokens.js";

/**
 * 🛑 THE RAMP COLOUR WAS ONE HARDCODED LITERAL SERVING TWO OPPOSITE GROUNDS.
 * `.is-soft` and `.is-warn` both read `var(--warning, #b45309)` and `--warning`
 * was defined in NEITHER theme, so the fallback answered every time. Measured
 * on `--bg-elevated`: 4.73 in light and 3.41 in dark, below the AA floor in
 * exactly one theme and silent about it.
 *
 * 🛑 BOLD CANNOT SUBSTITUTE FOR CONTRAST. lee asked whether the label should be
 * bold when it is coloured, and it should — but the gauge is 11px, so WCAG's
 * large-text relief (18.66px bold) never applies and the floor stays 4.5 at
 * every weight. Bold is for SCANNING. The tokens are for READING.
 *
 * ⚠️ A TRUE YELLOW CANNOT CLEAR AA ON A WHITE GROUND. Light mode's band 1 is a
 * dark gold for that reason, not by preference.
 */

/** WCAG 2.1 AA for body-sized text. The gauge is 11px, so this is the floor. */
const MIN_CONTRAST = 4.5;

/**
 * Two adjacent bands must not be the same colour.
 *
 * 🛑 THE FLOOR IS LOW ON PURPOSE AND THE CONTROL IS WHY IT STILL BITES. Three
 * dark-on-white hues that all clear 4.5 sit close together by necessity, so a
 * demanding separation floor is unreachable in light mode. The failure this
 * guards is the real one that shipped: two bands rendering the IDENTICAL hex,
 * which scores 0.
 */
const MIN_SEPARATION = 25;

/** Band 1, 2 and 3 of the ramp, quietest first. */
const RAMP_TOKENS = ["ramp-1", "ramp-2", "ramp-3"] as const;

/**
 * 🛑 EVERY GROUND THE GAUGE CAN RENDER ON, NOT THE ONE IT USES TODAY. The
 * sidebar is `--bg-elevated` and the agents card is reached from the same
 * `gaugeChip`, so a panel moving to `--bg` or `--bg-inset` must not silently
 * drop a band below the floor.
 */
const GROUNDS = ["bg", "bg-inset", "bg-elevated"] as const;

test("🛑 the sweep found every theme block — the denominator, not just the result", () => {
  const selectors = themeSelectors();

  assert.ok(
    selectors.length >= MIN_THEMES,
    `found ${selectors.length} theme blocks, expected at least ${MIN_THEMES}: ${selectors.join(", ")}`,
  );
  assert.ok(
    selectors.includes(":root"),
    `:root is missing from ${selectors.join(", ")}`,
  );
});

test("🛑 every ramp band is READABLE on every ground, in every theme", () => {
  const failures = themeSelectors().flatMap((selector) =>
    RAMP_TOKENS.flatMap((name) =>
      GROUNDS.map((ground) => ({
        selector,
        name,
        ground,
        ratio: contrastRatio(token(selector, name), token(selector, ground)),
      })).filter(({ ratio }) => ratio < MIN_CONTRAST),
    ),
  );

  assert.deepEqual(
    failures,
    [],
    `below AA: ${failures.map((f) => `${f.selector} --${f.name} on --${f.ground} at ${f.ratio.toFixed(2)}`).join(", ")}`,
  );
});

test("🛑 no two adjacent bands are the same colour, in every theme", () => {
  const pairs: [string, string][] = [
    ["ramp-1", "ramp-2"],
    ["ramp-2", "ramp-3"],
  ];

  const tooClose = themeSelectors().flatMap((selector) =>
    pairs
      .map(([a, b]) => ({
        selector,
        pair: `${a}/${b}`,
        gap: channelDistance(token(selector, a), token(selector, b)),
      }))
      .filter(({ gap }) => gap < MIN_SEPARATION),
  );

  assert.deepEqual(
    tooClose,
    [],
    `indistinguishable: ${tooClose.map((t) => `${t.selector} ${t.pair} at ${t.gap}`).join(", ")}`,
  );
});

test("the ramp tokens are defined in every theme, not only the first", () => {
  // A token missing from a theme block falls back through the cascade to the
  // light value, which is the shape that made the old amber wrong in dark.
  for (const selector of themeSelectors()) {
    for (const name of RAMP_TOKENS) {
      assert.match(
        token(selector, name),
        /^#[0-9a-f]{6}$/i,
        `${selector} --${name}`,
      );
    }
  }
});

test("🛑 no ramp rule falls back to a literal colour, which is how the old bug hid", () => {
  // `var(--warning, #b45309)` looked like a token read and was a hardcoded
  // literal, because `--warning` never existed. A fallback in the var() is the
  // tell, so the rules must name the token alone.
  for (const level of [1, 2, 3]) {
    const rule = block(`.sidebar__item-gauge.is-ramp${level}`);

    assert.match(rule, new RegExp(`color: var\\(--ramp-${level}\\)`));
    assert.doesNotMatch(
      rule,
      /var\(--[a-z0-9-]+,/,
      `.is-ramp${level} has a var() fallback, so a missing token would render a literal`,
    );
  }
});

test("🛑 every COLOURED band is bold, and the default one is not — lee, 2026-11-18", () => {
  // Bold is the scanning cue that survives a colour-blind reader and a bad
  // monitor. The default band stays unweighted so the coloured ones read as a
  // change rather than as the norm.
  for (const level of [1, 2, 3]) {
    assert.match(
      block(`.sidebar__item-gauge.is-ramp${level}`),
      /font-weight: 600/,
      `.is-ramp${level} is coloured but not bold`,
    );
  }

  assert.doesNotMatch(
    block(".sidebar__item-gauge"),
    /font-weight:/,
    "the base gauge rule sets a weight, so the bold bands no longer stand out",
  );
});

test("⚠️ control — the OLD hardcoded amber fails the floor in dark, which is the bug", () => {
  // Proves the contrast floor discriminates. A floor every colour passes is no
  // floor. 3.41 measured on the dark sidebar before this PR.
  const dark = themeSelectors().find((s) => s.includes("dark"));
  assert.ok(dark, "the dark theme block is gone");

  const ratio = contrastRatio("#b45309", token(dark, "bg-elevated"));

  assert.ok(
    ratio < MIN_CONTRAST,
    `the old amber scored ${ratio.toFixed(2)} in dark, which no longer fails AA`,
  );
});

test("⚠️ control — two bands sharing one hex fails the separation floor", () => {
  // The exact shape that shipped: `.is-soft` and `.is-warn` were the same
  // literal, so the ramp had two visible levels where it claimed three.
  assert.ok(
    channelDistance("#b45309", "#b45309") < MIN_SEPARATION,
    "identical colours now pass the separation floor, so it guards nothing",
  );
});

test("the retired --warning token has not come back as a silent fallback", () => {
  assert.ok(
    !CSS.includes("var(--warning,"),
    "a var(--warning, …) fallback is back in the stylesheet",
  );
});
