import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SETTINGS_TABS, settingsTabSelection } from "../../web/assets/logic.js";

/**
 * #397 — settings had nowhere to live, so they were attached to status cards.
 *
 * 🛑 lee RULED TWO TABS AND A THIRD LATER, 2026-11-22: *"we can add a third tab
 * later on right? let's start with two, just use responsive markup to account
 * for it"*. The strip is therefore built from a LIST, and the last test here is
 * that ruling's enforcement — not a style preference.
 */

test("the tab set is a list, with unique ids and a label each", () => {
  assert.ok(SETTINGS_TABS.length >= 2);

  const ids = SETTINGS_TABS.map((t) => t.id);

  assert.equal(new Set(ids).size, ids.length, "duplicate tab id");

  for (const t of SETTINGS_TABS) {
    assert.equal(typeof t.id, "string");
    assert.ok(t.id.length > 0);
    assert.ok(t.label.length > 0, `${t.id} has no label`);
  }
});

test("no request opens the first tab", () => {
  assert.equal(settingsTabSelection(null), SETTINGS_TABS[0].id);
  assert.equal(settingsTabSelection(undefined), SETTINGS_TABS[0].id);
});

/**
 * 🛑 AN UNKNOWN ID MUST NOT OPEN A BLANK MODAL. A renamed or removed tab is
 * the reachable case: the id outlives the tab in a bookmark or in state.
 */
test("an unknown tab id falls back to the first tab", () => {
  // Derived, not written down: a literal like "maintenance" becomes a real id
  // the day that tab ships, and this test then asserts the opposite of what it
  // says while still passing.
  const absent = SETTINGS_TABS.map((t) => t.id).join("-") + "-absent";

  assert.equal(settingsTabSelection(absent), SETTINGS_TABS[0].id);
  assert.equal(settingsTabSelection(""), SETTINGS_TABS[0].id);
});

test("a known tab id is kept", () => {
  for (const t of SETTINGS_TABS) {
    assert.equal(settingsTabSelection(t.id), t.id);
  }
});

/**
 * 🛑 lee's RULING, ASSERTED: adding a third tab is ONE list entry and NO CSS.
 *
 * The failure this guards is a strip that only lays out at two — a
 * `repeat(2, 1fr)` or an `:nth-child(2)` reads fine today and silently breaks
 * the third tab, which is exactly when nobody is looking at this file.
 *
 * ⚠️ EVERY BLOCK, INCLUDING INSIDE `@media`. claude2 measured two holes in the
 * first version of this test on PR 401: `repeat(2, 1fr)` passed it, and a rule
 * in a `@media` after `.settings__placeholder` sat outside its regex entirely.
 * Collecting blocks by brace-matching from each selector occurrence reaches
 * both. Neither hole was live — the CSS was read.
 */
function tabBlocks(css: string): { selector: string; body: string }[] {
  const out: { selector: string; body: string }[] = [];

  for (let i = css.indexOf(".settings__tab"); i !== -1;) {
    const open = css.indexOf("{", i);

    if (open === -1) break;

    // Back up to the start of the selector, so a grouped or nested one is
    // reported whole rather than from the middle.
    const prev = Math.max(
      css.lastIndexOf("}", i),
      css.lastIndexOf("{", i),
      css.lastIndexOf("*/", i),
    );
    const selector = css.slice(prev + 1, open).trim();

    let depth = 1;
    let j = open + 1;

    while (j < css.length && depth > 0) {
      if (css[j] === "{") depth++;
      else if (css[j] === "}") depth--;
      j++;
    }

    out.push({ selector, body: css.slice(open, j) });
    i = css.indexOf(".settings__tab", j);
  }

  return out;
}

test("the tab strip's CSS is keyed to no tab count and no tab id", () => {
  const css = readFileSync(
    new URL("../../web/assets/style.css", import.meta.url),
    "utf8",
  );

  const blocks = tabBlocks(css);

  // The matcher's own non-vacuity control. A regex that found nothing would
  // make every assertion below pass over an empty set.
  assert.ok(blocks.length >= 2, `only ${blocks.length} .settings__tab blocks`);

  for (const { selector, body } of blocks) {
    const where = `${selector} {…}`;

    // 🛑 SELECTOR AND BODY TOGETHER. `nth-child` lives in the SELECTOR, so a
    // body-only check read `{ display: none }` and passed. claude2's @media
    // hole SURVIVED my first fix for exactly that reason, and only running the
    // mutant again said so.
    const rule = `${selector} ${body}`;

    assert.doesNotMatch(
      rule,
      /nth-child|nth-of-type|:(?:first|last|only)-(?:child|of-type)/,
      `${where} is positional`,
    );
    assert.doesNotMatch(
      rule,
      /\brepeat\s*\(/,
      `${where} repeats a track count`,
    );
    assert.doesNotMatch(
      rule,
      /grid-template-columns/,
      `${where} fixes columns`,
    );
    assert.doesNotMatch(rule, /\b(?:50|33|25|20)%/, `${where} is a share of N`);

    for (const t of SETTINGS_TABS) {
      assert.doesNotMatch(
        selector,
        new RegExp(`--${t.id}\\b`),
        `CSS names the "${t.id}" tab, so a new tab needs a new rule`,
      );
    }
  }
});
