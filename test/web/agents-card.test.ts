import { test } from "node:test";
import assert from "node:assert/strict";
import {
  agentRow,
  agentsPanelEmpty,
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
