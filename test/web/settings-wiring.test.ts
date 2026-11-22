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
 * 🛑 THE PLATFORM OWNS THE FOCUS TRAP. A class toggle gives a box that looks
 * modal and lets Tab walk out of it into the page behind.
 */
test("the dialog opens with showModal(), not a class toggle", () => {
  assert.match(APP_CODE, /el\.settings\.showModal\(\)/);
  assert.match(APP_CODE, /el\.settings\.close\(\)/);
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
