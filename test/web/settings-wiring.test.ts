import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SETTINGS_TABS } from "../../web/assets/logic.js";

/**
 * #397 — the settings modal is actually WIRED.
 *
 * 🛑 EVERY TEST IN `settings-tabs.test.ts` PASSES WITH THE MODAL ABSENT. Those
 * helpers are pure. Same argument as `registration-wiring.test.ts`.
 */

const APP = readFileSync(
  new URL("../../web/assets/app.js", import.meta.url),
  "utf8",
);

const HTML = readFileSync(
  new URL("../../web/index.html", import.meta.url),
  "utf8",
);

/** `app.js` with both comment forms gone, so prose cannot satisfy a code check. */
const APP_CODE = APP.replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("//"))
  .join("\n");

/** The body of one top-level function in `app.js`, comments already gone. */
function fnBody(name: string): string {
  const m = APP_CODE.match(
    new RegExp(`(?:async )?function ${name}\\([^)]*\\)[\\s\\S]*?\\n\\}`),
  );

  assert.notEqual(m, null, `${name}() not found in app.js`);

  // The capture's own non-vacuity control, lifted from the sibling wiring
  // tests: the regex stops at the first line starting with `}`, so a brace at
  // column 0 inside the body truncates it and every doesNotMatch then passes
  // over the half that was cut.
  const depth = [...m![0]].reduce(
    (d, c) => d + (c === "{" ? 1 : c === "}" ? -1 : 0),
    0,
  );

  assert.equal(depth, 0, `${name}()'s body is truncated — depth ${depth}`);

  return m![0];
}

test("index.html carries the opener and the dialog's three parts", () => {
  assert.match(HTML, /id="settings-open"/);
  assert.match(HTML, /<dialog[^>]*id="settings"/);
  assert.match(HTML, /id="settings-tabs"/);
  assert.match(HTML, /id="settings-panels"/);
});

/**
 * 🛑 THE TAB BUTTONS ARE NOT IN THE MARKUP. lee ruled a third tab must be one
 * list entry; a button in `index.html` would make it an entry AND a markup edit.
 */
test("index.html hardcodes no tab button", () => {
  assert.doesNotMatch(HTML, /class="settings__tab\b/);

  for (const tab of SETTINGS_TABS) {
    assert.doesNotMatch(
      HTML,
      new RegExp(`data-settings-tab="${tab.id}"`),
      `index.html names the "${tab.id}" tab`,
    );
  }
});

test("the strip is built by mapping the list, not written out tab by tab", () => {
  const body = fnBody("renderSettings");

  assert.match(body, /SETTINGS_TABS\.map\(/);

  for (const tab of SETTINGS_TABS) {
    assert.doesNotMatch(
      body,
      new RegExp(`["'\`]${tab.label}["'\`]`),
      `renderSettings() writes the "${tab.label}" label as a literal`,
    );
  }
});

/**
 * 🛑 THE OPENER MUST RENDER, AND RENDER FIRST.
 *
 * Found by claude2 on PR 401: with `renderSettings(null)` deleted from this
 * handler, all ten tests here stayed GREEN and the modal opened with no tab
 * strip and no panel. Every other test proves the renderer is CORRECT and none
 * proved it was CALLED — the exact trap this file's own header warns about.
 *
 * Order is asserted too. Rendering after `showModal()` shows an empty dialog
 * first, which is a flash of the broken state rather than the broken state.
 */
test("the opener renders the modal BEFORE it shows it", () => {
  const m = APP_CODE.match(
    /el\.settingsOpen\.addEventListener\([\s\S]*?\n\}\);/,
  );

  assert.notEqual(m, null, "no click handler on el.settingsOpen");

  const handler = m![0];
  const rendered = handler.indexOf("renderSettings(");
  const shown = handler.indexOf("showModal()");

  assert.notEqual(rendered, -1, "the opener never calls renderSettings()");
  assert.notEqual(shown, -1, "the opener never calls showModal()");
  assert.ok(
    rendered < shown,
    "showModal() runs before renderSettings(), so the dialog opens empty",
  );
});

/**
 * 🛑 THE PLATFORM OWNS THE FOCUS TRAP. A class toggle gives a box that looks
 * modal and lets Tab walk out of it into the page behind.
 */
test("the dialog opens with showModal(), not a class toggle", () => {
  assert.match(APP_CODE, /el\.settings\.showModal\(\)/);
  assert.match(APP_CODE, /el\.settings\.close\(\)/);
});

/**
 * 🛑 THE NEXT TWO TESTS PIN THE SHAPE OF THE ASSIGNMENT AND CANNOT SEE ITS
 * VALUE. `app.js` runs at import and reaches `document.getElementById`, so
 * `renderSettings` can never be CALLED from a test. That is #330.
 *
 * 🛑 MEASURED SURVIVING MUTANT, so a reader can re-run it:
 *   `state.settingsTab = active` -> `state.settingsTab = SETTINGS_TABS[0].id`
 *   tsc exit 0 · this file 9/9 · full suite 2712/2712 · EXIT 0
 * It is not `requested`, and `settingsTabSelection(` still precedes the store,
 * so BOTH assertions below hold for a store that is always wrong.
 *
 * ⚠️ THE VALUE PROOF BELONGS TO ITEM 3, where `submitRegistration` reads
 * `state.settingsTab` back and re-renders the panel. A wrong stored value
 * changes what that call renders, and a test CAN observe that. Until item 3
 * lands, neither name below is a value guarantee.
 */

/**
 * 🛑 THE ACTIVE TAB MUST LIVE IN STATE, NOT ONLY IN THE DOM. Slice 2 moves the
 * register form in here, and `submitRegistration` has to re-render the panel it
 * now lives on. With the tab readable only as an `is-active` class, the only
 * argument it could pass is `null`.
 *
 * ⚠️ `null` WOULD WORK TODAY BY COINCIDENCE. It falls back to `tabs[0]`, which
 * is the tab the form sits on. It breaks the day a tab is inserted before it,
 * and lee's ruling that a new tab is ONE list entry is what makes that a
 * supported edit.
 */
test("renderSettings contains an assignment to state.settingsTab", () => {
  const body = fnBody("renderSettings");

  assert.match(
    body,
    /state\.settingsTab\s*=/,
    "renderSettings() never records which tab it drew",
  );
});

/**
 * 🛑 THE RESOLVED ID, NEVER THE REQUESTED ONE. `settingsTabSelection` is what
 * turns an unknown id into a real tab. Storing the raw argument would put a
 * tab id in state that no tab answers to, and the next caller would pass it
 * straight back.
 */
test("the assignment names the resolved id, not `requested`", () => {
  const body = fnBody("renderSettings");

  assert.doesNotMatch(
    body,
    /state\.settingsTab\s*=\s*requested\b/,
    "the raw argument is stored, so an unknown id survives in state",
  );

  const resolved = body.indexOf("settingsTabSelection(");
  const stored = body.search(/state\.settingsTab\s*=/);

  assert.notEqual(resolved, -1, "renderSettings() does not resolve the tab");
  assert.ok(
    resolved < stored,
    "the tab is stored before it is resolved, so the stored id is unchecked",
  );
});

/**
 * ⚠️ THE OPENER STILL RESETS, AND THAT IS THIS SLICE'S CHOICE. Reopening on
 * the last-used tab is a behaviour change nobody asked for, so item 1 adds the
 * state slot WITHOUT altering what the operator sees.
 */
test("the opener still resets to the first tab rather than resuming", () => {
  const m = APP_CODE.match(
    /el\.settingsOpen\.addEventListener\([\s\S]*?\n\}\);/,
  );

  assert.notEqual(m, null, "no click handler on el.settingsOpen");
  assert.match(
    m![0],
    /renderSettings\(null\)/,
    "the opener resumes a tab instead of resetting, which this slice did not intend",
  );
});

/**
 * 🛑 THE WHOLE POINT OF #397. The sidebar is destroyed and rebuilt on every
 * peer event (#399). A settings control reachable from that path is destroyed
 * mid-use, which is the defect this ticket exists to end.
 */
test("renderSidebar never touches the settings modal", () => {
  const body = fnBody("renderSidebar");

  assert.doesNotMatch(body, /renderSettings/);
  assert.doesNotMatch(body, /el\.settings/);
});
