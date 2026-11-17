import { test } from "node:test";
import assert from "node:assert/strict";
import {
  agentRow,
  agentsPanelEmpty,
  stopAllConfirmText,
  stopAllVisible,
  stopButtonClass,
  stopConfirmText,
  stopOutcomeText,
} from "../../web/assets/logic.js";

/**
 * #40 — the dashboard half. The route half shipped in PR 296.
 *
 * 🛑 THE ROW'S STOP TARGET IS THE SUPERVISOR HANDLE, AND THE GAUGE BESIDE IT
 * BELONGS TO THE CHILD. Those are two different handles on one row, and
 * posting the child's gets a tested, honest-looking `ok: false`.
 */

const NOW = 1_700_000_000_000;

const live = (over: Record<string, unknown> = {}) => ({
  handle: "smoke-container",
  boundAt: NOW - 2 * 60 * 60 * 1000,
  child: {
    handle: "smoke-container-agent",
    context_used: 32_673,
    context_total: 200_000,
    fresh: true,
    age_ms: 1000,
  },
  ...over,
});

test("the row's stop target is the supervisor, never the child", () => {
  const r = agentRow(live(), { nowMs: NOW });

  assert.equal(r.handle, "smoke-container");
  assert.equal(r.childHandle, "smoke-container-agent");
});

test("the gauge is read from the child, because the supervisor has no context", () => {
  const r = agentRow(live(), { nowMs: NOW });

  assert.equal(r.gauge.show, true);
  assert.equal(r.gauge.percent, 16);
  assert.equal(r.gauge.band, "ok");
});

/**
 * 🛑 "bound", NEVER "uptime". A restart respawns the child without rebinding
 * the socket, so this number outlives the child sitting beside it. Labelling
 * it uptime would have an operator read a fresh agent as a two-hour-old one.
 */
test("the age is labelled bound, because it is the socket's age and not the child's", () => {
  assert.equal(agentRow(live(), { nowMs: NOW }).bound, "bound 2h");
  assert.match(agentRow(live(), { nowMs: NOW }).boundTitle, /supervisor/i);
  assert.doesNotMatch(agentRow(live(), { nowMs: NOW }).bound, /uptime/i);
});

/**
 * `boundAtOf` fails open, so a stat it cannot read becomes `Date.now()`. A
 * zero or negative delta must not render as "-1m", which reads as a bug in
 * the page rather than a missing stat.
 */
test("a clock that runs backwards reads as a moment ago, not a negative age", () => {
  const future = agentRow(live({ boundAt: NOW + 5000 }), { nowMs: NOW });

  assert.equal(future.bound, "bound 0m");
});

test("a missing bind time says so, rather than borrowing ageLabel's never-reported", () => {
  const r = agentRow(live({ boundAt: null }), { nowMs: NOW });

  assert.equal(r.bound, "bound time unknown");
});

/**
 * A supervisor with no registered child is normal — it binds its socket
 * before the child's first bus touch.
 */
test("a supervisor with no child still renders, with no gauge", () => {
  const r = agentRow(live({ child: null }), { nowMs: NOW });

  assert.equal(r.handle, "smoke-container");
  assert.equal(r.childHandle, null);
  assert.equal(r.gauge.show, false);
});

/**
 * 🛑 SAYS IT IS EMPTY. A blank panel and a panel whose fetch failed look
 * identical, which is #103's frozen gauge in a different place.
 */
test("the empty panel says nothing is running, in words", () => {
  assert.match(agentsPanelEmpty(), /no supervised agents/i);
});

/**
 * lee's ruling of 2026-10-31: graceful is the default because a turn killed
 * mid-stream spends its tokens and produces nothing. The confirm copy is
 * where that cost reaches the operator.
 */
test("the two modes warn about different things, and only now mentions the cost", () => {
  const graceful = stopConfirmText("smoke-container", "graceful");
  const now = stopConfirmText("smoke-container", "now");

  assert.match(graceful, /smoke-container/);
  assert.match(graceful, /finishes/i);
  assert.doesNotMatch(graceful, /mid-stream/i);

  assert.match(now, /mid-stream/i);
  assert.match(now, /tokens/i);
});

/**
 * 🛑 BRANCH ON `reason`, NEVER ON `error`. `reason` is a two-value
 * discriminant; `error` is prose and free to be reworded. PR 298 fixed
 * exactly this drift in the CLI, so the page must not reintroduce it.
 */
test("an unreachable stop is named by its reason, not by the server's prose", () => {
  const out = stopOutcomeText([
    {
      handle: "smoke-container",
      ok: false,
      reason: "unreachable",
      error: "no supervisor is listening",
    },
  ]);

  assert.match(out.text, /unreachable/);
  assert.doesNotMatch(out.text, /no supervisor is listening/);
  assert.equal(out.kind, "error");
});

test("a refused stop is distinguished from an unreachable one", () => {
  const out = stopOutcomeText([
    {
      handle: "smoke-container",
      ok: false,
      reason: "refused",
      error: "already stopping",
    },
  ]);

  assert.match(out.text, /refused/);
  assert.equal(out.kind, "error");
});

test("a reason the page has never seen is reported verbatim, not swallowed", () => {
  const out = stopOutcomeText([
    { handle: "smoke-container", ok: false, reason: "quarantined" },
  ]);

  assert.match(out.text, /quarantined/);
  assert.equal(out.kind, "error");
});

test("a failure with no reason at all still reports the handle and fails loudly", () => {
  const out = stopOutcomeText([{ handle: "smoke-container", ok: false }]);

  assert.match(out.text, /smoke-container/);
  assert.equal(out.kind, "error");
});

test("a graceful stop reports the grace window, because the agent is not gone yet", () => {
  const out = stopOutcomeText([
    { handle: "smoke-container", ok: true, graceSeconds: 30 },
  ]);

  assert.match(out.text, /smoke-container/);
  assert.match(out.text, /30s/);
  assert.equal(out.kind, "info");
});

test("a stop with no grace window does not invent one", () => {
  const out = stopOutcomeText([{ handle: "smoke-container", ok: true }]);

  assert.equal(out.kind, "info");
  assert.doesNotMatch(out.text, /undefined|NaN|s\b/);
});

/**
 * ⚠️ FAILURES FIRST. A mixed result read as "stopped 2" is how an operator
 * walks away from an agent that is still running.
 */
test("a mixed result leads with the failure and still counts the successes", () => {
  const out = stopOutcomeText([
    { handle: "a", ok: true },
    { handle: "b", ok: false, reason: "refused" },
    { handle: "c", ok: true },
  ]);

  assert.equal(out.kind, "error");
  assert.match(out.text, /b refused/);
  assert.match(out.text, /2 of 3/);
});

/**
 * 🛑 AN EMPTY SWEEP IS NOT A SUCCESS. `stopped: 0` with no rows means nothing
 * was running, and "stopped 0 agents" reads as a stop that worked.
 */
test("an empty result set says nothing was running", () => {
  const out = stopOutcomeText([]);

  assert.match(out.text, /nothing/i);
  assert.equal(out.kind, "info");
});

// ── The Stop all sweep (#40) ─────────────────────────────────────────────

/**
 * 🛑 THE SWEEP IS HIDDEN FOR ONE AGENT, because that row's own Stop already
 * stops it. Offering both is two controls for one outcome, which is the
 * objection that kept the sweep out of PR 301.
 */
test("the sweep is offered only once a second agent is running", () => {
  assert.equal(stopAllVisible(0), false);
  assert.equal(stopAllVisible(1), false);
  assert.equal(stopAllVisible(2), true);
  assert.equal(stopAllVisible(9), true);
});

/**
 * 🛑 VISIBILITY IS AN AFFORDANCE, NOT A PRECONDITION. The route enumerates
 * live sockets itself, so a count that drops to 1 between render and click
 * still sweeps correctly — this helper must never become a guard.
 */
test("the sweep's own count is not what the confirm promises", () => {
  const text = stopAllConfirmText(3, "graceful");

  assert.match(text, /panel shows 3 agents/);
  assert.match(text, /whatever is answering/i);
});

test("a one-agent confirm still reads as English, because the helper is callable alone", () => {
  assert.match(stopAllConfirmText(1, "graceful"), /shows 1 agent,/);
});

/**
 * lee's ruling of 2026-10-31: graceful by default because a turn cut
 * mid-stream spends its tokens and produces nothing. A sweep pays that cost
 * once per agent, so the immediate copy is the one that must say it.
 */
test("only the immediate sweep mentions the cost, matching the per-row copy", () => {
  const graceful = stopAllConfirmText(3, "graceful");
  const now = stopAllConfirmText(3, "now");

  assert.match(graceful, /finishes its current turn/i);
  assert.doesNotMatch(graceful, /mid-stream/i);

  assert.match(now, /mid-stream/i);
  assert.match(now, /tokens/i);
});

/**
 * ⚠️ THE SWEEP AND THE ROW ARE DIFFERENT QUESTIONS. A confirm naming one
 * handle on a sweep is how an operator stops five agents believing they
 * stopped one.
 */
test("the sweep confirm names no single handle", () => {
  for (const mode of ["graceful", "now"] as const) {
    const text = stopAllConfirmText(3, mode);

    assert.match(text, /^Stop all agents/);
    assert.doesNotMatch(text, /smoke-container/);
  }
});

/**
 * The sweep's outcome goes through `stopOutcomeText`, which already counts
 * and already leads with failures. A second formatter would be free to drift
 * from the per-row one.
 */
test("a sweep that stops every agent reports the count, not a handle list", () => {
  const out = stopOutcomeText([
    { handle: "a", ok: true },
    { handle: "b", ok: true },
    { handle: "c", ok: true },
  ]);

  assert.equal(out.kind, "info");
  assert.match(out.text, /stopped 3 agents/);
});

/**
 * 🛑 ONLY THE CUT-MID-STREAM BUTTON IS COLOURED. Both of a pair in the danger
 * colour would say the graceful stop costs what the immediate one costs.
 * MEASURED: a hardcoded destructive class passed the source-text count in
 * `agents-wiring.test.ts`, which is why the decision moved here.
 */
test("only the immediate stop button takes the danger colour", () => {
  assert.equal(stopButtonClass("graceful"), "agent__stop");
  assert.equal(stopButtonClass("now"), "agent__stop is-destructive");
});
