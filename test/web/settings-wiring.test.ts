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
 * handler, EVERY test in this file stayed GREEN and the modal opened with no
 * tab strip and no panel. The others prove the renderer is CORRECT and none
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
 * 🛑 MEASURED SURVIVING MUTANT, re-run on 2026-11-24 after the panels landed:
 *   `state.settingsTab = active` -> `state.settingsTab = SETTINGS_TABS[0].id`
 *   tsc exit 0 · this file 16/16 · full suite 2718/2718 · EXIT 0
 * It is not `requested`, and `settingsTabSelection(` still precedes the store,
 * so BOTH assertions below hold for a store that is always wrong.
 *
 * 🛑 ITEM 3 HAS LANDED AND DID NOT KILL THAT MUTANT. The promise that used to
 * sit here was wrong: a test still cannot CALL `renderSettings`, so it still
 * cannot observe which panel a wrong stored value draws. What item 3 did buy is
 * the pin on `repaintSettings` below — the argument is now readable as source.
 * The value proof itself needs a browser and is #330.
 */

/**
 * 🛑 THE ACTIVE TAB MUST LIVE IN STATE, NOT ONLY IN THE DOM. #397 moved the
 * register form into the dialog, and eight handlers now repaint the panel it
 * lives on. With the tab readable only as an `is-active` class, the only
 * argument any of them could pass is `null`.
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
test("the assignment is not the raw argument, and resolution precedes it", () => {
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

/**
 * 🛑 THE PANEL LOOKUP IS DATA, NOT A BRANCH. lee ruled a new tab must be one
 * entry in `SETTINGS_TABS` and nothing else. A `if (active === "agents")` in the
 * renderer makes it an entry AND a branch, and the branch is the one a reader
 * adding the third tab does not know to look for.
 */
test("the panel is chosen by a lookup keyed on the tab id", () => {
  const body = fnBody("renderSettings");

  assert.match(body, /SETTINGS_PANEL_BUILDERS\[/);

  for (const tab of SETTINGS_TABS) {
    assert.doesNotMatch(
      body,
      new RegExp(`active\\s*===\\s*["'\`]${tab.id}["'\`]`),
      `renderSettings() branches on the "${tab.id}" tab instead of looking it up`,
    );
  }
});

/**
 * 🛑 A TAB WITHOUT A PANEL MUST STILL RENDER SOMETHING. `Rooms` has no builder
 * until its controls move, and an empty panel and a thrown renderer look
 * identical from the operator's side.
 *
 * ⚠️ THE OPTIONAL CALL IS THE WHOLE GUARD. `SETTINGS_PANEL_BUILDERS[active]()`
 * on a tab with no entry is a TypeError that takes the strip down with it.
 */
test("a tab with no builder falls back rather than throwing", () => {
  const body = fnBody("renderSettings");

  assert.match(
    body,
    /SETTINGS_PANEL_BUILDERS\[active\]\?\.\(\)/,
    "the builder is called unconditionally, so a tab without one throws",
  );
  assert.match(body, /settings__placeholder/);
});

/**
 * 🛑 THE AGENTS TAB IS WIRED TO THE REAL BUILDER. Every test above proves the
 * renderer is correct about tabs and none proved a panel has any content — the
 * same trap this file's header names for the opener.
 */
test("the agents tab is wired to agentsPanel", () => {
  const m = APP_CODE.match(/const SETTINGS_PANEL_BUILDERS = \{[\s\S]*?\n\};/);

  assert.notEqual(m, null, "no SETTINGS_PANEL_BUILDERS in app.js");
  assert.match(m![0], /agents:\s*agentsPanel\b/);
});

/**
 * 🛑 THE PANEL HOLDS TWO GROUPS AND THE ORDER IS THE ARGUMENT. The default is
 * the WEAKEST layer, so it reads after the specifics that override it — the
 * same order it held in the sidebar.
 *
 * ⚠️ A `gateControl` call alone is not enough. `agents-wiring.test.ts` counts
 * TWO call sites across the file, and a count cannot say which function holds
 * which one.
 */
test("the agents panel renders the registrations, then the global default", () => {
  const body = fnBody("agentsPanel");

  const registered = body.indexOf("registrationSection()");
  const gate = body.indexOf("gateControl({");

  assert.notEqual(registered, -1, "the agents panel drops the registrations");
  assert.notEqual(gate, -1, "the agents panel drops the global gate control");
  assert.ok(
    registered < gate,
    "the default reads above the specifics that override it",
  );
  assert.match(
    body,
    /scope: "global"/,
    "the panel builds a row-scoped control",
  );
});

/**
 * 🛑 BOTH SURFACES, FOR EITHER SCOPE, AND THE SIDEBAR IS THE ONE THAT GOES
 * SILENT. A handle with no override of its own resolves THROUGH the global, so
 * one global submit moves every inheriting row's number, its source label, and
 * the fill at which its gauge changes colour.
 *
 * ⚠️ REPAINTING ONLY THE DIALOG IS THE SILENT FAILURE. The operator sets a new
 * default, the dialog updates, and every row behind the modal keeps quoting the
 * old number until something unrelated rebuilds it.
 */
test("setGate repaints the sidebar AND the dialog", () => {
  const body = fnBody("setGate");

  assert.match(body, /renderSidebar\(\)/, "setGate never repaints the sidebar");
  assert.match(
    body,
    /repaintSettings\(\)/,
    "setGate never repaints the dialog",
  );
});

/**
 * 🛑 THE SCOPE GUARD IS GONE BECAUSE ITS SUBJECT IS. `state.gateEditing` held
 * a sidebar row's open editor; #397 slice 3b put that editor in a dialog whose
 * own open state replaces it, so `setGate` has nothing left to clear.
 *
 * ⚠️ A GUARD DELETED WITH ITS SUBJECT IS NOT A GUARD DROPPED. This asserts the
 * key is really gone rather than leaving the old test asserting a branch that
 * no longer exists.
 */
test("setGate clears no editor state, because none is left to clear", () => {
  const body = fnBody("setGate");

  assert.doesNotMatch(body, /gateEditing/);
  assert.match(
    body,
    /repaintThreshold\(\)/,
    "setGate never repaints the modal",
  );
});

/**
 * 🛑 THE ARGUMENT IS THE STORED TAB, NEVER `null`. `settingsTabSelection(null)`
 * resolves to the FIRST tab, so a null here pulls an operator who is on `Rooms`
 * back to `Agents` in the middle of what they were doing.
 *
 * ⚠️ IT WOULD PASS EVERY BEHAVIOURAL TEST TODAY BY COINCIDENCE, because
 * `agents` is both the first tab and the tab these controls sit on. That is
 * exactly why this is pinned as source text.
 */
test("the repaint keeps the operator's tab instead of resetting it", () => {
  const body = fnBody("repaintSettings");

  assert.match(body, /renderSettings\(state\.settingsTab\)/);
  assert.doesNotMatch(
    body,
    /renderSettings\(null\)/,
    "the repaint resets to the first tab, so it moves the operator off Rooms",
  );
});

/**
 * 🛑 ALL EIGHT HANDLERS REPAINT THE PANEL, AND NONE STILL REPAINTS THE SIDEBAR.
 * Their controls left the sidebar, so a `renderSidebar()` left behind is a call
 * that repaints nothing — the plan panel never opens and nothing errors.
 *
 * ⚠️ THE COUNT IS THE POINT. An earlier reading of this move named two sites,
 * and the six it missed are the plan controls.
 */
test("every handler whose controls moved repaints the panel, not the sidebar", () => {
  const handlers = {
    submitRegistration: 2,
    forgetRegistration: 1,
    openPlan: 3,
    approvePlan: 2,
  };

  let total = 0;

  for (const [name, expected] of Object.entries(handlers)) {
    const body = fnBody(name);
    const repaints = [...body.matchAll(/repaintSettings\(\)/g)].length;

    assert.equal(
      repaints,
      expected,
      `${name}() repaints the panel ${repaints} times, not ${expected}`,
    );
    assert.doesNotMatch(
      body,
      /renderSidebar\(\)/,
      `${name}() still repaints the sidebar, where its controls no longer are`,
    );

    total += repaints;
  }

  assert.equal(
    total,
    8,
    "the eight moved render sites are not all accounted for",
  );
});

/**
 * 🛑 THE SIDEBAR MUST NOT STILL CLAIM THE SECTION. `renderSidebar` walks
 * `SIDEBAR_SECTIONS` and calls `SECTION_BUILDERS[key]()`, so a key left in one
 * without a row in the other throws on the first render.
 */
test("the sidebar builds no registration section", () => {
  const m = APP_CODE.match(/const SECTION_BUILDERS = \{[\s\S]*?\n\};/);

  assert.notEqual(m, null, "no SECTION_BUILDERS in app.js");
  assert.doesNotMatch(m![0], /registration/);
});

/**
 * 🛑 THE PANEL PAYS ITS OWN GUTTER, SO THE SIDEBAR'S CLASSES DOUBLE IT.
 * `.settings__panels` already sets `padding: 16px` and `.sidebar__heading` adds
 * `4px 16px` on top. A class name that still says `sidebar` inside the dialog is
 * also the next reader's wrong premise about where this renders.
 */
test("the moved card carries no sidebar class names", () => {
  const section = fnBody("registrationSection");

  assert.doesNotMatch(section, /sidebar__/);
  assert.match(section, /settings__group\b/);
});
