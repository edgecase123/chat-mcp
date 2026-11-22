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
 * The failure this guards is a strip that only lays out at two — a `width: 50%`
 * or an `:nth-child(2)` rule reads fine today and silently breaks the third
 * tab, which is exactly when nobody is looking at this file.
 */
test("the tab strip's CSS is keyed to no tab count and no tab id", () => {
  const css = readFileSync(
    new URL("../../web/assets/style.css", import.meta.url),
    "utf8",
  );

  const strip = css.match(/\.settings__tabs[\s\S]*?(?=\n\.(?!settings__tab))/);

  assert.notEqual(strip, null, ".settings__tabs has no CSS block");

  const block = strip![0];

  assert.doesNotMatch(block, /nth-child/, "a positional rule pins the count");
  assert.doesNotMatch(block, /\b(?:50|33|25)%/, "a share-of-two width");

  for (const t of SETTINGS_TABS) {
    assert.doesNotMatch(
      block,
      new RegExp(`\\.settings__tab--${t.id}\\b`),
      `CSS names the "${t.id}" tab, so a new tab needs a new rule`,
    );
  }
});
