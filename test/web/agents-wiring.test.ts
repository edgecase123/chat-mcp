import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * 🛑 EVERY TEST IN `agents-card.test.ts` PASSES WITH THIS PANEL UNWIRED.
 *
 * Those helpers are pure, so they prove the strings are right and nothing
 * about whether a surface calls them. #224 shipped its bands three commits
 * before anything invoked them and a green suite said nothing for two
 * sessions.
 *
 * There is no DOM harness for `app.js` here, so the wiring is asserted
 * against the source text.
 */

const APP = readFileSync(
  new URL("../../web/assets/app.js", import.meta.url),
  "utf8",
);

/**
 * `app.js` with BOTH comment forms removed, so prose cannot satisfy a code
 * check.
 *
 * 🛑 THE BLOCK FORM IS NOT OPTIONAL. The sibling wiring tests strip only
 * `//` lines, and the first cut of this file passed its docblock off as a
 * code hit: a `/** ... *\/` sentence naming `/api/agents/stop` and the word
 * "child" failed the stop assertion on a clean tree.
 */
const APP_CODE = APP.replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("//"))
  .join("\n");

/** The body of one top-level function in `app.js`, comments already gone. */
function fnBody(name: string): string {
  const m = APP_CODE.match(
    new RegExp(`async function ${name}\\([^)]*\\)[\\s\\S]*?\\n\\}`),
  );

  assert.notEqual(m, null, `${name}() not found in app.js`);

  // 🛑 THE CAPTURE'S OWN NON-VACUITY CONTROL. The regex stops at the FIRST
  // line starting with `}`, so a brace at column 0 inside the body truncates
  // it and every `doesNotMatch` below then passes over the half that was cut.
  // MEASURED: a `child` reference behind such a brace passed 8 of 8 before
  // this assertion existed. Depth 0 means a whole function was captured.
  // Raised by claude1 reviewing PR 301.
  //
  // ⚠️ IT COUNTS BRACES IN STRINGS TOO, so a body holding an unbalanced brace
  // in a literal would trip it. None of the three callers has one, and a
  // false trip is a loud failure rather than a silent pass.
  const depth = [...m![0]].reduce(
    (d, c) => d + (c === "{" ? 1 : c === "}" ? -1 : 0),
    0,
  );

  assert.equal(
    depth,
    0,
    `${name}()'s captured body is truncated — brace depth ${depth}`,
  );

  return m![0];
}

test("🛑 the panel is built by agentRow, not by reading the route's fields", () => {
  const found = APP_CODE.match(/agentRow\(/g);

  // ⚠️ THE DENOMINATOR. No match means the panel stopped using the helper,
  // and then every claim below is about an empty list.
  assert.notEqual(found, null, "nothing calls agentRow");
  assert.equal(
    found!.length,
    1,
    `expected 1 agentRow call, got ${found!.length}`,
  );
});

/**
 * 🛑 THE AGE IS THE HELPER'S JOB. A second formatter in `app.js` is free to
 * drift from the one that carries the "bound, never uptime" rule and its test.
 */
test("🛑 app.js never formats a bind time itself", () => {
  assert.doesNotMatch(APP_CODE, /boundAt/, "app.js reads boundAt directly");
});

/**
 * 🛑 THE STOP TARGET IS THE SUPERVISOR. The row shows the child's gauge, so
 * the child's handle is the easy mistake and the route answers it with a
 * tested, honest-looking `ok: false`.
 */
test("🛑 the stop request posts the supervisor handle, never the child's", () => {
  // ⚠️ THE TARGET IS NAMED AT THE `stopButton` CALL SITES, NOT AT
  // `stopAgents`'. The sweep made `stopButton` the one place a button is
  // built, so a scan of the old symbol alone would be trivially true.
  const calls = APP_CODE.match(/stop(?:Agents|Button)\([^)]*\)/g);

  assert.notEqual(calls, null, "nothing calls stopAgents or stopButton");
  // THE DENOMINATOR: 4 buttons, stopButton's own stopAgents call, and the two
  // declarations.
  assert.ok(
    calls!.length >= 7,
    `only ${calls!.length} stop call sites found; the regex has drifted`,
  );

  for (const call of calls!) {
    assert.doesNotMatch(
      call,
      /child/i,
      `a stop is dispatched with a child handle: ${call}`,
    );
  }

  const body = fnBody("stopAgents");

  assert.match(body, /\/api\/agents\/stop/, "stopAgents posts somewhere else");
  assert.doesNotMatch(body, /child/i, "the stop request names a child handle");
});

/**
 * 🛑 `reason` IS THE DISCRIMINANT AND `error` IS PROSE. PR 298 fixed exactly
 * this drift in the CLI. The page must branch in one place, which is the
 * helper that has the tests.
 */
test("🛑 the outcome text is the helper's, and app.js reads neither reason nor error", () => {
  const found = APP_CODE.match(/stopOutcomeText\(/g);

  assert.notEqual(found, null, "nothing calls stopOutcomeText");
  assert.equal(found!.length, 1);

  // 🛑 SCOPED TO THE STOP PATH. `renderApprovals` renders an APPROVAL's
  // `reason`, which is a different field on a different route — a file-wide
  // assertion fails on a clean tree.
  assert.doesNotMatch(
    fnBody("stopAgents"),
    /\.reason\b/,
    "stopAgents branches on reason itself",
  );
});

/**
 * ⚠️ A PANEL THAT IS NEVER REFETCHED SHOWS A STOPPED AGENT AS RUNNING. The
 * periodic refresh is what makes the list a reading rather than a snapshot of
 * page load.
 */
test("🛑 refresh() fetches the live agents", () => {
  const refresh = APP_CODE.match(/async function refresh\(\)[\s\S]{0,400}/);

  assert.notEqual(refresh, null, "refresh() not found");
  assert.match(
    refresh![0],
    /await fetchLiveAgents\(\)/,
    "refresh() does not fetch the live agents",
  );
});

/**
 * 🛑 SAYS IT IS EMPTY. A blank panel and a failed fetch look identical, which
 * is #103's frozen gauge in a different place.
 */
test("🛑 the empty panel goes through agentsPanelEmpty", () => {
  assert.match(APP_CODE, /agentsPanelEmpty\(\)/);
});

/**
 * 🛑 ONE GAUGE CHIP. The peer row and the agent row both show it, and a
 * second copy is free to drift from `gaugeDisplay` — which is where the
 * stale-reading rule and its test live.
 */
test("🛑 the gauge chip has exactly one copy in app.js", () => {
  const chips = APP_CODE.match(/sidebar__item-gauge/g);

  assert.notEqual(chips, null, "the gauge chip class is gone");
  assert.equal(
    chips!.length,
    1,
    `the gauge chip is built in ${chips!.length} places`,
  );
});

/**
 * ⚠️ A FAILED FETCH MUST KEEP THE LAST KNOWN LIST. Blanking it makes a
 * RUNNING agent look stopped, and the operator's next action on that reading
 * is to walk away.
 */
test("🛑 a failed live-agents fetch does not blank the panel", () => {
  const fn = fnBody("fetchLiveAgents");

  assert.match(fn, /catch/, "fetchLiveAgents does not catch");
  // The assignment must be INSIDE the try, so a throw leaves the last list.
  const [beforeCatch] = fn.split("catch");

  assert.match(beforeCatch, /state\.agents = /);
  assert.doesNotMatch(
    fn.slice(fn.indexOf("catch")),
    /state\.agents = /,
    "the catch branch clears the panel",
  );
});

// ── The Stop all sweep (#40) ─────────────────────────────────────────────

/**
 * 🛑 THE SWEEP SENDS `all: true` AND NO HANDLE. The route prefers `all` when
 * both arrive, so a request carrying both would sweep while displaying a
 * handle nobody checked.
 */
test("🛑 the sweep posts all: true, and the named stop still posts a handle", () => {
  const body = fnBody("stopAgents");

  assert.match(body, /all: true/, "the sweep does not post all: true");
  assert.match(body, /handle: target/, "the named stop lost its handle");
});

/**
 * 🛑 THE CONFIRM IS THE HELPER'S. A sweep confirm written inline in `app.js`
 * is free to promise a count, which is the one thing its test forbids.
 */
test("🛑 the sweep's confirm goes through stopAllConfirmText, once", () => {
  const found = APP_CODE.match(/stopAllConfirmText\(/g);

  assert.notEqual(found, null, "nothing calls stopAllConfirmText");
  assert.equal(found!.length, 1);
  assert.match(fnBody("stopAgents"), /stopAllConfirmText\(/);
});

/**
 * ⚠️ THE GATE MUST BE THE HELPER, not an inline `length > 1`. A second copy
 * is free to drift from the test that pins the threshold.
 */
test("🛑 the sweep's visibility goes through stopAllVisible, once", () => {
  const found = APP_CODE.match(/stopAllVisible\(/g);

  assert.notEqual(found, null, "nothing calls stopAllVisible");
  assert.equal(found!.length, 1);
  assert.doesNotMatch(
    APP_CODE,
    /agents\.length > 1/,
    "the threshold is inlined beside the helper",
  );
});

/**
 * 🛑 THE SWEEP BUTTONS PASS `null`, NEVER A HANDLE. A handle here would stop
 * one agent while the operator read a confirm about all of them.
 */
test("🛑 both sweep buttons target null", () => {
  const sweeps = APP_CODE.match(/stopButton\("Stop all[^)]*\)/g);

  assert.notEqual(sweeps, null, "no Stop all button is built");
  assert.equal(
    sweeps!.length,
    2,
    `expected 2 sweep buttons, got ${sweeps!.length}`,
  );

  for (const call of sweeps!) {
    assert.match(
      call,
      /,\s*null\s*,/,
      `a sweep button names a target: ${call}`,
    );
  }
});

/**
 * 🛑 ONE HOME FOR THE DANGER COLOUR. Four buttons now, and both of a pair in
 * the danger colour would say the graceful stop costs what the immediate one
 * costs.
 */
test("🛑 app.js never decides a stop button's danger colour itself", () => {
  // 🛑 A COUNT OF THE CLASS LITERAL CANNOT SEE THE MUTANT THAT MATTERS.
  // MEASURED: hardcoding `"agent__stop is-destructive"` for BOTH buttons left
  // the count at 1 and passed 13 of 13. The decision is a tested helper now,
  // so the pin is that app.js calls it and never writes the class.
  const found = APP_CODE.match(/stopButtonClass\(/g);

  assert.notEqual(found, null, "nothing calls stopButtonClass");
  assert.equal(found!.length, 1);
  assert.doesNotMatch(
    APP_CODE,
    /agent__stop is-destructive/,
    "app.js sets the danger colour itself",
  );
});

/**
 * 🛑 THE ROW BUTTONS PASS THE ROW'S HANDLE, NEVER `null`. A null here turns a
 * per-row Stop into a SWEEP, so an operator stopping one agent stops every
 * one of them.
 *
 * ⚠️ THE PAIRED CONTROL TO "both sweep buttons target null". That test filters
 * on the "Stop all" label, so it still finds its 2 when the ROW buttons become
 * sweeps, and the `>= 7` call count does not move either. MEASURED: both row
 * buttons turned into sweeps passed 36 of 36 before this test existed.
 * Raised by claude1 reviewing PR 303.
 */
test("🛑 both row stop buttons target the row's handle", () => {
  const rows = APP_CODE.match(/stopButton\("Stop(?! all)[^)]*\)/g);

  assert.notEqual(rows, null, "no per-row stop button is built");
  assert.equal(rows!.length, 2, `expected 2 row buttons, got ${rows!.length}`);

  for (const call of rows!) {
    assert.match(
      call,
      /,\s*a\.handle\s*,/,
      `a row button lost its handle: ${call}`,
    );
  }
});
