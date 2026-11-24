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

/**
 * The body of one top-level function in `app.js`, comments already gone.
 *
 * ⚠️ `async` IS OPTIONAL, AND IT WAS NOT. Every caller happened to name an
 * async function, so a plain `function agentsSection()` reported
 * "not found" — which reads as "the function was deleted" rather than
 * "this helper cannot see it". The sibling wiring tests already allow both.
 */
function fnBody(name: string): string {
  const m = APP_CODE.match(
    new RegExp(`(?:async )?function ${name}\\([^)]*\\)[\\s\\S]*?\\n\\}`),
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
  // THE DENOMINATOR, reconciled PER SITE after #415 slice 2 collapsed the two
  // row literals into one mapped call: 1 row call, 2 sweep buttons,
  // stopButton's own stopAgents call, and the two declarations.
  assert.ok(
    calls!.length >= 6,
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
 * sweeps, and the `>= 6` call count does not move either. MEASURED: both row
 * buttons turned into sweeps passed 36 of 36 before this test existed.
 * Raised by claude1 reviewing PR 303.
 *
 * 🛑 #415 slice 2 — THE ROW IS NOW ONE MAPPED CALL, not two literals. The
 * labels moved into `stopButtonOrder`, where `stop-button-order.test.ts` pins
 * them as values; what stays here is the property a unit test cannot see,
 * which is that the RENDERER passes the row's handle.
 */
test("🛑 the row's stop buttons target the row's handle", () => {
  // ⚠️ THE LOOKBEHIND EXCLUDES THE DECLARATION, so the count is call sites
  // alone. Counting `function stopButton(label, target, mode)` too would let a
  // deleted row call site hide behind it.
  const rows = APP_CODE.match(
    /(?<!function )stopButton\((?!"Stop all)[^)]*\)/g,
  );

  assert.notEqual(rows, null, "no per-row stop button is built");
  assert.equal(
    rows!.length,
    1,
    `expected 1 row call site, got ${rows!.length}`,
  );

  for (const call of rows!) {
    assert.match(
      call,
      /,\s*a\.handle\s*,/,
      `a row button lost its handle: ${call}`,
    );
  }

  // 🛑 BOTH STOPS MUST STILL REACH THE ROW, SO THE PIN RUNS TO THE MAP'S
  // CLOSING PAREN AND REQUIRES A `,` THERE. A prefix match ends at `.map(` and
  // is blind to anything chained onto the RESULT: `.slice(0, 1)` renders one
  // button and satisfies every other assertion here. Raised by claude2
  // reviewing this PR, with a mutant that passed 24 of 24.
  //
  // ⚠️ THE `\s*` BEFORE `.map(` IS LOAD-BEARING. Appending to the chain makes
  // prettier break the line, so a pin without it reds for the FORMATTING and
  // not for the truncation — which measures the wrong thing.
  assert.match(
    APP_CODE,
    /stopButtonOrder\(a\.defaultStopMode\)\s*\.map\(\(b\) =>\s*stopButton\(b\.label, a\.handle, b\.mode\),?\s*\)\s*,/,
    "the row's mapped order is truncated or re-ordered before it renders",
  );
});

/**
 * #135 slice 4c — the gate control's wiring. Every test in
 * `gate-control.test.ts` passes with this unwired, which is the same gap this
 * file exists to close for the stop buttons.
 */
test("🛑 both gate controls are built by gateControl, with a denominator", () => {
  // ⚠️ THE LOOKBEHIND EXCLUDES THE DECLARATION, so the count is call sites
  // alone and the number means what this test's name says. Counting the
  // declaration too would let one deleted call site hide behind it.
  const found = APP_CODE.match(/(?<!function )gateControl\(\{/g);

  // ⚠️ THE DENOMINATOR. TWO call sites: the per-agent row in this section, and
  // the global default, which #397 moved into the settings dialog. One match
  // means a scope was dropped, and the surviving claims below would then all be
  // about the other one.
  //
  // 🛑 A COUNT CANNOT SAY WHERE EITHER ONE LIVES. The test below pins that.
  assert.notEqual(found, null, "nothing calls gateControl");
  assert.equal(
    found!.length,
    2,
    `expected 2 gateControl call sites, got ${found!.length}`,
  );
});

/**
 * 🛑 A SHIPPED ReferenceError, AND THE SUITE WAS GREEN THROUGH IT.
 *
 * PR 433 deleted `const key = global ? GLOBAL_GATE_KEY : handle` and left one
 * read of `key` behind, in the Edit button's onclick. Clicking Edit on any
 * agent row threw `ReferenceError: key is not defined` and the editor never
 * opened. Every test here pins `app.js` as TEXT and none executes it, so
 * nothing could see it.
 *
 * 🛑 `key` IS THE RIGHT THING TO BAN, NOT `handle` THE RIGHT THING TO REQUIRE.
 * The constant is gone, so any `key` identifier in this builder is a leftover
 * read of a binding that does not exist.
 *
 * ⚠️ THIS CATCHES THE INSTANCE, NOT THE CLASS. A different free variable still
 * ships green. The only instrument that sees the class is a compiler, and
 * `checkJs` is off here by lee's ruling on #177 — see `typecheck-config.test.ts`.
 * MEASURED, so the gap is a number rather than a worry. The invocation is part
 * of the measurement — an ad-hoc run over `app.js` alone reports a tenth of the
 * debt and reads as though this comment went stale:
 *
 *   npx tsc -p tsconfig.test.json --checkJs
 *     TS2304 "Cannot find name"   1 before this fix, 0 after
 *     every other code            509 in `web/assets`, all pre-existing
 *     and 14 more outside it, in `scripts/lib/fresh-image.mjs`
 */
test("🛑 gateControl reads no binding that was deleted with GLOBAL_GATE_KEY", () => {
  const body = fnBody("gateControl");

  // ⚠️ THE POSITIVE HALF NAMED A LINE #397 slice 3b DELETED. The Edit/Done
  // toggle went with `state.gateEditing`, so the ban is what survives.
  assert.doesNotMatch(
    body,
    /null : key\b/,
    "gateControl reads `key`, which was deleted with GLOBAL_GATE_KEY",
  );
  // The denominator: this must be reading a real body, not an empty string.
  assert.match(body, /gateControlDisplay\(/, "fnBody returned nothing useful");
});

/**
 * 🛑 THE GLOBAL CONTROL LEFT THIS SECTION, AND THE COUNT ABOVE CANNOT SEE THAT.
 * Moving it back would keep the call count at two and red nothing. The sidebar
 * rebuilds on every peer event, which is the whole reason #397 moved it.
 */
test("the agents section builds no gate control at all", () => {
  const body = fnBody("agentsSection");

  // ⚠️ WAS "no GLOBAL control" WITH A POSITIVE CONTROL ON THE ROW ONE.
  // #397 slice 3b moved the row control onto the `⋯` menu too, so the
  // positive half has nothing left to assert and the claim widened.
  assert.doesNotMatch(
    body,
    /gateControl\(\{/,
    "a gate control is still inline on a row",
  );
  assert.doesNotMatch(body, /state\.gateDefault/);
  // The positive control moves to the thing that SHOULD still be there: the
  // row itself, which carries the menu the control moved into.
  assert.match(
    body,
    /sidebarItem\(\{/,
    "the agent row is gone, so this proves nothing",
  );
});

/**
 * 🛑 THE GATE IS STORED AGAINST THE CHILD AND THE STOP TARGETS THE SUPERVISOR.
 * The two handles differ by a suffix, so posting the wrong one reads as
 * correct and comes back 404.
 */
test("🛑 the threshold is opened on the CHILD handle, not the supervisor's", () => {
  // ⚠️ THE CONTROL MOVED, THE CLAIM DID NOT. It used to be asserted on the
  // inline `gateControl` call; #397 slice 3b moved it to the row menu's
  // handler, and the trap is identical — the two handles differ by a suffix,
  // so posting the wrong one reads as correct and comes back 404.
  const row = fnBody("agentsSection");
  assert.match(
    row,
    /target: a\.childHandle/,
    "the agent row's menu targets the supervisor",
  );

  // 🛑 `target`, NEVER `label`. `agentRow` documents `label` as falling back to
  // the SUPERVISOR handle when no child has bound. They are equal for every row
  // built today, so `label` would be correct by coincidence.
  const menu = fnBody("itemMenu");
  assert.match(menu, /setThreshold: \(\) => openThreshold\(target\)/);
  assert.doesNotMatch(
    menu,
    /openThreshold\(label\)/,
    "the threshold opens on the row's LABEL, which can be the supervisor",
  );
});

/**
 * 🛑 THE DEFAULT COMES FROM THE PAYLOAD, NOT FROM A ROW. A peer reports the
 * global only while it has no override, so deriving it from the rows renders
 * nothing on a page where every agent is overridden.
 */
test("🛑 the footer reads the global default from whoami, not from the rows", () => {
  const body = fnBody("fetchWhoami");

  assert.match(body, /context_gate_default/, "fetchWhoami drops the default");
  assert.match(
    APP_CODE,
    /resolved: state\.gateDefault/,
    "the footer does not read state.gateDefault",
  );
});

/**
 * 🛑 THE VALIDATOR MUST RUN BEFORE THE POST. Its whole purpose is to answer the
 * operator without a round trip, and the one shape it exists to catch — an
 * empty box on the GLOBAL — is answered 400 by the route.
 */
test("🛑 setGate validates with gateSubmission before it posts", () => {
  const body = fnBody("setGate");
  const check = body.indexOf("gateSubmission(");
  const post = body.indexOf("/api/context-gate");

  assert.notEqual(check, -1, "setGate never calls gateSubmission");
  assert.notEqual(post, -1, "setGate never posts to the gate route");
  assert.ok(check < post, "setGate posts BEFORE it validates");
  assert.match(body, /scope/, "setGate drops the scope argument");
});

/**
 * ⚠️ A GATE CHANGE INVALIDATES BOTH PAYLOADS. The rows carry each agent's
 * resolved gate and whoami carries the default, so refetching one leaves the
 * other showing a number nobody has re-read.
 */
test("🛑 a gate change refetches both payloads, not just the rows", () => {
  const body = fnBody("setGate");

  assert.match(body, /fetchWhoami\(\)/, "setGate leaves the default stale");
  assert.match(body, /fetchLiveAgents\(\)/, "setGate leaves the rows stale");
  assert.match(body, /renderSidebar\(\)/, "setGate never repaints");
});

/**
 * 🛑 THE GUARD `boot()`'s OWN DOCBLOCK ASKS FOR AND NEVER GOT. It says: "BOOT
 * DOES NOT CALL refresh(), SO EVERY NEW VIEW MUST BE LISTED HERE TOO. The
 * approvals card was added to refresh() only, which meant a blocked agent was
 * invisible until some unrelated wake event arrived."
 *
 * That comment was written after the approvals card hit it, and two more
 * panels hit it afterwards anyway. MEASURED on `origin/main`: `boot()` named
 * neither `fetchLiveAgents` nor `fetchClaims`, so a freshly opened page said
 * "(no supervised agents running)" with two supervisors live, until a wake
 * event arrived. An empty panel and a panel nobody filled look identical.
 *
 * 🛑 IT KEYS ON FUNCTIONS THIS FILE DECLARES, NOT ON A `fetch` NAME PREFIX.
 * The first cut matched `/fetch[A-Z]\w*\(/` over a floor of `>= 4`, which is
 * the same fail-open shape as PR 325's: a rename OUT of the prefix drops the
 * call from the set, the floor still clears on the survivors, and the missing
 * name is then never checked against `boot()` at all.
 *
 * MEASURED across five arms, by claude2 reviewing this PR and then by me:
 *
 * ```
 * arm                                        prefix+floor   declared-callee
 * 1  clean tree                              pass           pass
 * 2  fetchClaims cut from boot()             FAIL           FAIL
 * 3  renamed to loadClaims AND cut           pass  <-OPEN   FAIL
 * 4  await dropped AND cut                   FAIL           FAIL
 * 5  Promise.all refactor, still in boot     pass           pass
 * 6  declared `const … = async function`     n/a            FAIL
 * 7  declared `const … = async () =>`        n/a            FAIL
 * ```
 *
 * 🛑 ARMS 6 AND 7 ARE WHY `declared` READS TWO FORMS, NOT ONE. Keying only on
 * `function name(` left a view declared as a `const` invisible to the matcher,
 * and the floor's margin of one absorbed the shrink — the same arithmetic as
 * the `>= 4` floor it replaced, one layer up. Raised by claude2 re-reviewing
 * this PR, who measured the gap and then declined to claim their own fix
 * worked, because their re-implementation and the real file disagreed. The
 * real file is the instrument: patched and re-run here, it closes both arms.
 *
 * ⚠️ `await (\w+)\(` WAS ALSO MEASURED AND IS WORSE. It closes arm 3, reopens
 * arm 4, and false-alarms on arm 5 — `await Promise.all([…])` collapses the
 * set to `Promise`, and `setGate` in this same PR already uses that idiom.
 *
 * ⚠️ MATCHING EVERY CALLED IDENTIFIER WAS MEASURED AND IS WORSE STILL. It
 * picks up `console.error`'s `error(` and `Promise.all`'s `all(`, so it
 * false-alarms on a clean tree and needs an exemption list that grows.
 *
 * ⚠️ `fetchMessages` IS THE ONE EXEMPTION AND IT IS NOT A LOOPHOLE. It is
 * conditional on `state.currentTarget` in `refresh()`, and on boot no
 * conversation is open yet, so there is nothing to fetch. Every other call in
 * the set is unconditional.
 */
test("🛑 every view refresh() fills, boot() fills too — an empty panel must not lie", () => {
  const refresh = fnBody("refresh");
  const boot = fnBody("boot");
  const EXEMPT = new Set(["fetchMessages"]);

  // Top-level functions `app.js` defines. A call to one of these is a view
  // this file owns; `console.error` and `Promise.all` are not, which is what
  // keeps the match from needing an exemption list that grows.
  const declared = new Set([
    ...[...APP_CODE.matchAll(/^(?:async )?function (\w+)\(/gm)].map(
      (m) => m[1]!,
    ),
    ...[
      ...APP_CODE.matchAll(/^const (\w+) = (?:async )?(?:function\s*)?\(/gm),
    ].map((m) => m[1]!),
  ]);

  // 🛑 `refresh` ITSELF IS EXCLUDED BECAUSE fnBody CAPTURES THE SIGNATURE LINE.
  // Without this the guard demands that boot() call refresh(), which is the one
  // thing boot deliberately does not do.
  const called = [
    ...new Set([...refresh.matchAll(/\b(\w+)\(/g)].map((m) => m[1]!)),
  ].filter((n) => declared.has(n) && n !== "refresh");

  // ⚠️ THE DENOMINATOR. A match that collapsed to nothing would make the claim
  // below vacuously true, which is this file's recurring failure shape.
  assert.ok(
    called.length >= 8,
    `only ${called.length} app.js calls found in refresh(); the matcher has drifted: ${called.join(", ")}`,
  );

  const missing = called.filter(
    (f) => !EXEMPT.has(f) && !boot.includes(`${f}(`),
  );

  assert.deepEqual(
    missing,
    [],
    `refresh() calls these and boot() does not, so they are empty or unpainted on a fresh page load: ${missing.join(", ")}`,
  );
});

/**
 * 🛑 #374 — TWO HANDLES, ONE ROW, AND THEY MUST NOT SWAP. The row READS as
 * the child, because that is the handle a human messages and clicks to DM.
 * `/api/agents/stop` accepts only the supervisor, and so does a terminal kill,
 * so the supervisor has to stay FINDABLE — it rides on the wrapper's tooltip.
 *
 * ⚠️ A `data-supervisor` ATTRIBUTE WAS THE FIRST CUT AND IT WAS DEAD MARKUP.
 * Nothing in `web/` or `src/` read it, so the only reader was a test written to
 * give it one. A tooltip has a reader: the browser renders it. Raised by
 * claude2 reviewing this PR.
 */
test("🛑 the agent row targets the child and names its supervisor", () => {
  const wrapper = APP_CODE.match(
    /h\(\s*"div",\s*\{\s*className:\s*"agent",\s*title:\s*`([^`]+)`/,
  );

  assert.notEqual(wrapper, null, "no .agent wrapper with a title");
  assert.match(
    wrapper![1]!,
    /\$\{a\.handle\}/,
    "the tooltip must name the SUPERVISOR handle",
  );
  assert.doesNotMatch(
    wrapper![1]!,
    /childHandle/,
    "the tooltip names the child, which the row already shows",
  );

  // THE OTHER HALF, and the test is vacuous without it: a tooltip holding the
  // supervisor proves nothing if the clickable row targets it too.
  const row = APP_CODE.match(/sidebarItem\(\{[\s\S]*?target:\s*([^,]+),/);

  assert.notEqual(row, null, "the agent row is not a sidebarItem any more");
  assert.equal(
    row![1]!.trim(),
    "a.childHandle",
    "the clickable row must target the CHILD handle",
  );
});

/**
 * 🛑 A LIVE SUPERVISOR IS NOT A CONNECTED CHILD, AND THE FIRST CUT SAID IT
 * WAS. `online: true` was hardcoded on the agent row, so the dot was green
 * forever — and `cursorSpawn.processPerTurn` is `true`, meaning a Cursor handle
 * is genuinely offline between turns. lee's ruling was that these rows look
 * like peer rows, and a peer row's dot tells the truth. Raised by claude2.
 */
test("🛑 the agent row's online state is read, never asserted", () => {
  const agentsRow = APP_CODE.slice(
    APP_CODE.indexOf("function agentsSection("),
    APP_CODE.indexOf("function peersSection("),
  );

  assert.ok(agentsRow.length > 0, "agentsSection() not found before peers");
  assert.match(
    agentsRow,
    /online:\s*childOnline\(/,
    "the agent row must resolve online from the peer record",
  );
  assert.doesNotMatch(
    agentsRow,
    /online:\s*(?:true|false)\b/,
    "the agent row hardcodes an online state",
  );
});
