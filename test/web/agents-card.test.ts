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
  const r = agentRow(live());

  assert.equal(r.handle, "smoke-container");
  assert.equal(r.childHandle, "smoke-container-agent");
});

test("the gauge is read from the child, because the supervisor has no context", () => {
  const r = agentRow(live());

  assert.equal(r.gauge.show, true);
  assert.equal(r.gauge.percent, 16);
  assert.equal(r.gauge.band, "ok");
});

/**
 * 🛑 THE THREE `bound Nm` TESTS THAT STOOD HERE ARE DELETED, NOT MOVED. They
 * pinned the label's wording, the clock-skew clamp and the unreadable-stat
 * case — a contract lee removed on 2026-11-21, because an operator acts on no
 * part of a supervisor's socket age. `agent-row-one-row.test.ts` asserts the
 * row carries no such field at all (#374).
 */

/**
 * A supervisor with no registered child is normal — it binds its socket
 * before the child's first bus touch.
 */
test("a supervisor with no child still renders, with no gauge", () => {
  const r = agentRow(live({ child: null }));

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
 * 🛑 EACH MODE NAMES BOTH OUTCOMES, because nothing in the browser can
 * tell whether a turn is running (#415, lee's ruling of 2026-11-23).
 *
 * ⚠️ THE SECOND LIMB IS THE DISCRIMINATOR. `/finishes/i` alone passed
 * against the defect too, so an idle-case assertion is what detects the fix.
 */
test("each stop mode names both the running-turn and the idle outcome", () => {
  const graceful = stopConfirmText("smoke-container", "graceful");
  const now = stopConfirmText("smoke-container", "now");

  assert.match(graceful, /smoke-container/);
  assert.match(graceful, /if a turn is running, it finishes first/i);
  assert.match(graceful, /if none is running, this starts one and bills it/i);
  assert.doesNotMatch(graceful, /mid-stream/i);
  assert.doesNotMatch(graceful, /its current turn/i);

  assert.match(now, /cut mid-stream/i);
  assert.match(now, /if none is running, nothing is spent/i);
  assert.match(now, /tokens/i);
  assert.doesNotMatch(now, /its current turn/i);
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
 * 🛑 THE SWEEP NAMES BOTH OUTCOMES TOO. It was the second site of the
 * same defect and #415 did not name it, so a one-site fix left an honest row
 * dialog beside a misleading sweep dialog on one panel.
 */
test("each sweep mode names both the running-turn and the idle outcome", () => {
  const graceful = stopAllConfirmText(3, "graceful");
  const now = stopAllConfirmText(3, "now");

  assert.match(graceful, /each one with a turn running finishes it first/i);
  assert.match(graceful, /each one idle starts a turn and bills it/i);
  assert.doesNotMatch(graceful, /mid-stream/i);
  assert.doesNotMatch(graceful, /finishes its current turn/i);

  assert.match(now, /cut mid-stream/i);
  assert.match(now, /an idle agent spends nothing/i);
  assert.match(now, /tokens/i);
  assert.doesNotMatch(now, /every turn in flight/i);
});

/**
 * 🛑 NEITHER CONFIRM MAY ASSERT A TURN IS RUNNING, AND THIS TEST IS WHY
 * ONE SITE CANNOT BE FIXED ALONE. It names both functions, so repairing the row
 * copy while leaving the sweep copy reds here rather than shipping.
 */
test("no stop confirm asserts that a turn is running", () => {
  const texts = [
    stopConfirmText("smoke-container", "graceful"),
    stopConfirmText("smoke-container", "now"),
    stopAllConfirmText(3, "graceful"),
    stopAllConfirmText(3, "now"),
  ];

  // ⚠️ A TRIPWIRE, NOT A MEASUREMENT. The array is a literal, so this
  // cannot fail today. It reds if someone later builds the list from a
  // helper that reaches fewer strings than there are confirms.
  assert.equal(texts.length, 4);

  for (const text of texts) {
    assert.doesNotMatch(text, /its current turn/i);
    assert.doesNotMatch(text, /finishes its current turn/i);
    assert.doesNotMatch(text, /every turn in flight/i);
    // 🛑 NO IMMEDIACY PROMISE EITHER. The containerized driver awaits
    // `dockerTeardownFor`, up to the grace window plus 5s, and this copy
    // cannot see which driver the handle runs under.
    assert.doesNotMatch(text, /immediately/i);
    // Both limbs: the running case and the idle case, in every string.
    assert.match(
      text,
      /if a turn is running|with a turn running|turn in flight/i,
    );
    assert.match(text, /if none is running|each one idle|an idle agent/i);
  }
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

/**
 * #135 slice 4c — the row carries the CHILD's gate, because the gate control
 * sits on the row and the gate is stored against the agent, not the supervisor.
 *
 * 🛑 `undefined` HERE IS A SILENT WRONG ANSWER, NOT AN ERROR. A missing gate
 * reaches `gateControlDisplay`, falls through to the built-in label and renders
 * a plausible "built-in default" on a row that is in fact overridden. Nothing
 * throws, and the number on screen is simply wrong.
 */
test("the row carries the child's gate and the layer that answered", () => {
  const r = agentRow(
    live({
      child: {
        handle: "smoke-container-agent",
        context_used: 32_673,
        context_total: 200_000,
        fresh: true,
        age_ms: 1000,
        context_gate: 25,
        context_gate_source: "override",
      },
    }),
  );

  assert.equal(r.gate, 25);
  assert.equal(r.gateSource, "override");
});

/**
 * 🛑 A SUPERVISOR WITH NO CHILD HAS NO GATE, AND MUST NOT REPORT A NUMBER.
 * `gateFields` is never resolved for a null child, so inventing one here would
 * put a second copy of the three-layer default in the browser.
 */
test("a supervisor with no child reports no gate at all", () => {
  const r = agentRow(live({ child: null }));

  assert.equal(r.gate, null);
  assert.equal(r.gateSource, null);
});
