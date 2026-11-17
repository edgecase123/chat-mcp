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
  const calls = APP_CODE.match(/stopAgent\([^)]*\)/g);

  assert.notEqual(calls, null, "nothing calls stopAgent");
  // Two buttons, one declaration site.
  assert.ok(
    calls!.length >= 2,
    `only ${calls!.length} stopAgent references found; the regex has drifted`,
  );

  for (const call of calls!) {
    assert.doesNotMatch(
      call,
      /child/i,
      `a stop is dispatched with a child handle: ${call}`,
    );
  }

  const body = fnBody("stopAgent");

  assert.match(body, /\/api\/agents\/stop/, "stopAgent posts somewhere else");
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

  // 🛑 SCOPED TO THE STOP PATH. `app.js:1489` renders an APPROVAL's reason,
  // which is a different field on a different route — a file-wide assertion
  // fails on a clean tree.
  assert.doesNotMatch(
    fnBody("stopAgent"),
    /\.reason\b/,
    "stopAgent branches on reason itself",
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
