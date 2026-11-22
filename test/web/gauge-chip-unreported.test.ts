import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * #371 — `gaugeDisplay` can return the `unreported` band and `gauge-display.
 * test.ts` proves it does. Nothing there reaches the chip that renders it, and
 * a band with no glyph of its own renders the same `–` as stale — which is the
 * ambiguity this change exists to remove.
 *
 * 🛑 THERE IS NO DOM HARNESS FOR `app.js` HERE — that is #330. A source-text
 * regex is the ONLY instrument available for a claim about this file, and this
 * header is the label that says so.
 */

const APP = readFileSync(
  new URL("../../web/assets/app.js", import.meta.url),
  "utf8",
);

/**
 * `app.js` with BOTH comment forms removed, so prose cannot satisfy a code
 * check.
 *
 * 🛑 NOT OPTIONAL HERE, AND NOT THEORETICALLY. `gaugeChip`'s own comment names
 * `n/a` and the `–` it must not reuse, in that order. Against the raw file
 * every assertion below passes with the function body deleted.
 */
const CODE = APP.replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("//"))
  .join("\n");

/** `gaugeChip`'s body, comments already gone. */
function gaugeChipBody(): string {
  const m = CODE.match(/function gaugeChip\([^)]*\)[\s\S]*?\n\}/);

  assert.notEqual(m, null, "gaugeChip() not found in app.js");

  // The capture's own non-vacuity control, copied from `agents-wiring.test.ts`
  // for the reason recorded there: the regex stops at the first line starting
  // with `}`, so a brace at column 0 truncates the body and every assertion
  // below then runs against the half that was kept.
  const depth = [...m![0]].reduce(
    (d, c) => d + (c === "{" ? 1 : c === "}" ? -1 : 0),
    0,
  );

  assert.equal(depth, 0, "gaugeChip's capture was truncated mid-body");

  return m![0];
}

test("🛑 the chip gives the unreported band its OWN glyph, not stale's dash", () => {
  const body = gaugeChipBody();

  assert.match(body, /unreported/, "gaugeChip never reads the band");
  assert.match(body, /"n\/a"/, "no n/a glyph, so unreported renders as stale");
});

/**
 * 🛑 THE BAND STILL HAS TO REACH THE CLASS, OR THE CSS CANNOT STYLE IT. The
 * glyph assertion above passes on a chip that hardcodes one class name.
 */
test("🛑 the band is interpolated into the chip's class", () => {
  assert.match(gaugeChipBody(), /sidebar__item-gauge is-\$\{gauge\.band\}/);
});

/**
 * 🛑 THE CSS IS THE OTHER HALF AND NOTHING ELSE ASSERTS IT. A chip emitting
 * `is-unreported` against a stylesheet with no such rule renders at full
 * strength, indistinguishable from a live reading.
 */
test("🛑 the stylesheet has a rule for the band the chip emits", () => {
  const css = readFileSync(
    new URL("../../web/assets/style.css", import.meta.url),
    "utf8",
  );

  assert.match(css, /\.sidebar__item-gauge\.is-unreported\s*\{/);
});
