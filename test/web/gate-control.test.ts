import { test } from "node:test";
import assert from "node:assert/strict";
import {
  gateTargetFor,
  gateSubmission,
  gateRisk,
  gateControlDisplay,
} from "../../web/assets/logic.js";

/**
 * #135 unit 4, slice 4b — the gate control's decisions, with no DOM under them.
 *
 * 🛑 THE BROWSER CANNOT SEE A CHILD'S SPAWN FLOOR. `childFloor` is a local in
 * the supervisor process and reaches no table, so `gateRisk` is keyed on the
 * peer's CURRENT fill, which the whoami payload does carry. Current fill is
 * always at or above the floor, so "below current fill" cannot tell an
 * immediate restart apart from permanent silence — and the copy must not
 * pretend it can.
 */

test("a whole percentage in range is accepted and carries the number", () => {
  for (const raw of ["1", "50", "100", " 42 "]) {
    const out = gateSubmission(raw);
    assert.equal(out.ok, true, `${raw} was refused`);
    assert.equal(out.gate, Number(raw.trim()));
  }
});

test("an empty box is a CLEAR, not a zero", () => {
  for (const raw of ["", "   "]) {
    const out = gateSubmission(raw);
    assert.equal(out.ok, true);
    assert.equal(out.gate, null, "an empty box became a number");
  }
});

/**
 * Each of these is a different clause of the refusal, and the storage setter
 * rejects on the same four. A browser that accepted one would post a body the
 * route answers 400, which is a worse experience than refusing it here.
 */
test("every illegal shape is refused, and says which rule it broke", () => {
  const cases: Array<[string, RegExp]> = [
    ["0", /1 to 100/],
    ["101", /1 to 100/],
    ["-5", /1 to 100/],
    ["50.5", /whole/],
    ["abc", /number/],
    ["1e2", /whole|number/],
  ];

  for (const [raw, reason] of cases) {
    const out = gateSubmission(raw);
    assert.equal(out.ok, false, `${raw} was accepted`);
    assert.ok(out.reason, `${raw} was refused with no reason at all`);
    assert.match(out.reason, reason, `${raw} gave the wrong reason`);
  }
});

/**
 * 🛑 THE POSITIVE CONTROL. Without it a `gateRisk` that returned a warning for
 * EVERY gate would pass every assertion below and look correct.
 */
test("a gate well above the current fill carries NO warning", () => {
  assert.equal(gateRisk(80, 20), null);
  assert.equal(gateRisk(50, 14.4), null);
});

test("a gate at or below the current fill warns, and names SILENCE as the risk", () => {
  for (const gate of [20, 14, 10]) {
    const risk = gateRisk(gate, 20);
    assert.ok(risk, `gate ${gate} under a 20% fill gave no warning`);
    assert.match(
      risk.message,
      /nothing will restart|never restart/i,
      `gate ${gate} warned without naming silence`,
    );
  }
});

/**
 * 🛑 THIS ASSERTS THE SEVERITY, NOT MERELY A NON-NULL. It first checked only
 * that something came back, and a `>` mutant passed it: gate 20 against fill 20
 * fell through to the `soon` branch, which is also non-null. A test that cannot
 * fail on the mutant it was written for is not a test.
 */
test("the equal case is SILENT — at or below, not strictly below", () => {
  const risk = gateRisk(20, 20);
  assert.ok(risk, "gate == fill was treated as safe");
  assert.equal(risk.severity, "silent", "gate == fill was downgraded to soon");
});

/**
 * ⚠️ A GATE JUST ABOVE THE FILL IS A DIFFERENT, MILDER CASE and must not
 * borrow the silence wording. It fires soon, which is often what the operator
 * wants.
 */
test("a gate just above the current fill warns that it fires SOON, not that it silences", () => {
  const risk = gateRisk(23, 20);
  assert.ok(risk, "a 3-point margin gave no note at all");
  assert.equal(risk.severity, "soon");
  assert.doesNotMatch(risk.message, /nothing will restart|never restart/i);
});

test("the two severities are distinct, so the UI can style them apart", () => {
  const under = gateRisk(10, 20);
  const above = gateRisk(23, 20);
  assert.ok(under, "a gate under the fill gave no warning at all");
  assert.ok(above, "a gate just above the fill gave no warning at all");
  assert.equal(under.severity, "silent");
  assert.equal(above.severity, "soon");
});

/**
 * A peer that has never reported has no fill to compare against. Inventing one
 * would put a second home for the spawn floor in the browser, which is the
 * mistake `context_ramp` exists to avoid.
 */
test("with no known fill there is no warning, because there is nothing to compare", () => {
  assert.equal(gateRisk(10, null), null);
  assert.equal(gateRisk(10, undefined), null);
});

/**
 * A CLEAR is not a low gate. `gateSubmission("")` answers `gate: null`, which
 * hands the handle back to the global default, so something still restarts it.
 * Warning "nothing will restart it" there states the opposite of what happens.
 *
 * 🛑 `fillPercent` IS TYPE-GUARDED AND `gate` WAS NOT. `null <= 20` is true,
 * so the clear fell into the `silent` branch, while `undefined` reached the
 * `soon` arithmetic, went NaN and returned null — which is why probing with
 * `undefined` alone reports no fault.
 */
test("a cleared gate warns nothing, because falling back to the global default still restarts", () => {
  assert.equal(gateRisk(null, 20), null);
  assert.equal(gateRisk(undefined, 20), null);
  assert.equal(gateRisk(Number.NaN, 20), null);
});

/**
 * #135 slice 4c — the SAME empty box means two different things, and only one
 * of them is legal.
 *
 * 🛑 `gateSubmission` WAS SCOPE-BLIND AND THE ROUTE'S RULE IS SCOPE-DEPENDENT.
 * An empty box is a legal CLEAR for a handle, which returns it to the global
 * default. There is no layer below the global, so clearing IT has nothing to
 * fall back to, and `handleContextGateSet` answers 400. MEASURED by claude2
 * before this control was written: `gateSubmission("")` said `{ok: true,
 * gate: null}` and the POST came back 400.
 *
 * ⚠️ THE WHOLE POINT OF THIS VALIDATOR IS TO ANSWER BEFORE A ROUND TRIP, so a
 * shape it waves through to a guaranteed 400 is the one defect it cannot have.
 */
test("an empty box is refused for the GLOBAL default, because nothing sits below it", () => {
  for (const raw of ["", "   "]) {
    const out = gateSubmission(raw, { scope: "global" });
    assert.equal(out.ok, false, `an empty global box was accepted: ${raw}`);
    assert.ok(out.reason, "refused with no reason at all");
    assert.match(
      out.reason,
      /cannot be cleared|no layer below|every agent/i,
      "the reason does not say why the global is different",
    );
  }
});

/**
 * 🛑 THE POSITIVE CONTROL FOR THE CLAUSE ABOVE. A `gateSubmission` that
 * refused an empty box in EVERY scope would pass that test and break the only
 * way to undo a per-handle override.
 */
test("an empty box is still a CLEAR for a handle, and for the default scope", () => {
  for (const opts of [undefined, {}, { scope: "handle" }]) {
    const out = gateSubmission("", opts);
    assert.equal(
      out.ok,
      true,
      `a handle clear was refused: ${JSON.stringify(opts)}`,
    );
    assert.equal(out.gate, null, "a handle clear stopped being a clear");
  }
});

/**
 * ⚠️ SCOPE CHANGES ONE CLAUSE, NOT THE RULE. A global set is still a number
 * from 1 to 100, and the four refusals are unchanged — so a scope argument
 * that accidentally short-circuited the range test would be invisible without
 * this.
 */
test("the global scope refuses every illegal number the handle scope refuses", () => {
  for (const raw of ["0", "101", "50.5", "abc"]) {
    const out = gateSubmission(raw, { scope: "global" });
    assert.equal(out.ok, false, `${raw} was accepted for the global`);
  }

  const good = gateSubmission("50", { scope: "global" });
  assert.equal(good.ok, true, "a legal global gate was refused");
  assert.equal(good.gate, 50);
});

/**
 * #135 slice 4c — what one gate control RENDERS, with no DOM under it.
 *
 * 🛑 THE NUMBER ALONE CANNOT TELL THE OPERATOR WHETHER `[Clear]` DOES
 * ANYTHING. A row showing 50 may be overridden to 50, following a global 50,
 * or sitting on the built-in — and clearing only has an effect in the first
 * case. `resolveContextGateWithSource` answers which, and this turns that
 * answer into the control's state.
 */
test("a per-handle OVERRIDE is the only state that offers a clear", () => {
  const out = gateControlDisplay(
    { gate: 25, source: "override" },
    { scope: "handle" },
  );

  assert.equal(out.gate, 25);
  assert.equal(out.canClear, true, "an override had nothing to clear");
  assert.match(out.label, /25/);
  assert.match(out.label, /this agent/i, "the label does not name the layer");
});

/**
 * 🛑 THE TWO NEGATIVE CONTROLS FOR THE CLAUSE ABOVE. A `canClear` hardcoded
 * true passes the override test and breaks both of these, and a hardcoded
 * false does the reverse.
 */
test("an INHERITED gate offers no clear, because there is no override to remove", () => {
  for (const source of ["global", "builtin"]) {
    const out = gateControlDisplay({ gate: 50, source }, { scope: "handle" });
    assert.equal(out.canClear, false, `${source} offered a pointless clear`);
    assert.match(out.label, /50/);
    assert.doesNotMatch(
      out.label,
      /this agent/i,
      `${source} was labelled as an override`,
    );
  }
});

/** The two inherited layers must read apart, or the label is decoration. */
test("the global default and the built-in default are labelled differently", () => {
  const g = gateControlDisplay({ gate: 50, source: "global" }, {});
  const b = gateControlDisplay({ gate: 50, source: "builtin" }, {});

  assert.notEqual(g.label, b.label);
  assert.match(b.label, /built-in/i);
});

/**
 * ⚠️ THE RISK NOTE IS THE SAME `gateRisk` THE SET FORM USES, so a row showing
 * a gate already under its agent's fill warns without the operator typing
 * anything.
 */
test("a row whose gate is already under its agent's fill carries the silence warning", () => {
  const out = gateControlDisplay(
    { gate: 20, source: "override" },
    { scope: "handle", fillPercent: 42 },
  );

  assert.ok(out.risk, "a gate under the current fill rendered no warning");
  assert.equal(out.risk.severity, "silent");
});

/** The positive control: a safe gate must render NO note at all. */
test("a row whose gate is well above its agent's fill carries no note", () => {
  const out = gateControlDisplay(
    { gate: 80, source: "override" },
    { scope: "handle", fillPercent: 20 },
  );

  assert.equal(out.risk, null);
});

/**
 * 🛑 THE GLOBAL SCOPE HAS NO SINGLE FILL TO WARN ABOUT. Every agent resolves
 * the default against its own, so one warning there would name a number that
 * belongs to nobody.
 */
test("the global scope never offers a clear and never carries a risk note", () => {
  const out = gateControlDisplay(
    { gate: 20, source: "global" },
    { scope: "global", fillPercent: 42 },
  );

  assert.equal(out.canClear, false, "the global offered a clear");
  assert.equal(out.risk, null, "the global warned about one agent's fill");
  assert.match(out.label, /default/i);
});

/**
 * 🛑 THE `!global` GUARD, ON ITS OWN. The test above feeds the global scope a
 * `source` of "global", so `source === "override"` is already false there and
 * dropping the scope guard changes nothing it can see.
 *
 * MEASURED: `canClear: source === "override"` — the guard deleted — passed 19
 * of 19. The rule is "the global has no layer below it, whatever source it was
 * handed", and this is the only case that states it.
 */
test("the global scope refuses a clear even when handed an override source", () => {
  const out = gateControlDisplay(
    { gate: 30, source: "override" },
    { scope: "global" },
  );

  assert.equal(out.canClear, false, "the global offered a clear");
});

/**
 * #397 slice 3b — the `⋯` menu's `Set Threshold…` needs one handle's gate and
 * its current fill, and the two row types keep them in different slices of
 * state.
 *
 * 🛑 THE SERVER WRITES BOTH THROUGH `gateFields()`, so the FIELD NAMES agree
 * even though the paths do not. `whoami.peers[]` carries them directly;
 * `/api/agents/live` carries them on `agents[].child`. One resolver is what
 * stops two call sites drifting.
 */

const AGENT_ROW = {
  handle: "sup-a",
  child: {
    handle: "sup-a-agent",
    context_gate: 25,
    context_gate_source: "override",
    context_used: 42_000,
    context_total: 200_000,
    // 🛑 `fresh: true` IS NOT DECORATION. `gaugeDisplay` returns a NULL percent
    // for any row it considers stale, so a fixture without it measures the
    // stale path while reading as the happy one. It cost me a wrong expected
    // value before the first run.
    fresh: true,
  },
};

const PEER_ROW = {
  handle: "cursor-b",
  context_gate: 60,
  context_gate_source: "global",
  context_used: 30_000,
  context_total: 200_000,
  fresh: true,
};

test("🛑 an AGENT row resolves through its child, not its supervisor handle", () => {
  const got = gateTargetFor("sup-a-agent", {
    agents: [AGENT_ROW],
    peers: [],
  });

  assert.deepEqual(got, { gate: 25, source: "override", fillPercent: 21 });

  // ⚠️ THE SUPERVISOR HANDLE MUST NOT RESOLVE. The two differ by a suffix, so
  // a resolver that matched either would read as correct and gate the wrong
  // handle — the same trap the row's own docblock names about the Stop button.
  assert.equal(
    gateTargetFor("sup-a", { agents: [AGENT_ROW], peers: [] }),
    null,
  );
});

test("🛑 a PEER row resolves from state.peers, with the same field names", () => {
  const got = gateTargetFor("cursor-b", { agents: [], peers: [PEER_ROW] });

  assert.deepEqual(got, { gate: 60, source: "global", fillPercent: 15 });
});

/**
 * 🛑 A SUPERVISED CHILD IS IN BOTH LISTS. `peersMinusSupervised` hides it from
 * the peers SECTION, but `state.peers` still holds it. Searching peers first
 * would answer with a row the operator did not click.
 */
test("🛑 a handle in BOTH lists resolves as the agent row", () => {
  const alsoAPeer = { ...PEER_ROW, handle: "sup-a-agent", context_gate: 99 };
  const got = gateTargetFor("sup-a-agent", {
    agents: [AGENT_ROW],
    peers: [alsoAPeer],
  });

  assert.equal(
    got?.gate,
    25,
    "the peers entry won, so the agent row is shadowed",
  );
});

/**
 * ⚠️ `show: true` WITH A NULL PERCENT IS A REAL STATE — a vendor that reports
 * no context window. `fillPercent` must be null there, or `gateRisk` compares
 * a threshold against a number that does not exist.
 */
test("⚠️ a row that reports no window resolves a NULL fill, not a zero", () => {
  const noWindow = {
    handle: "cursor-c",
    context_gate: 50,
    context_gate_source: "builtin",
    reports_context: false,
  };

  assert.deepEqual(
    gateTargetFor("cursor-c", { agents: [], peers: [noWindow] }),
    {
      gate: 50,
      source: "builtin",
      fillPercent: null,
    },
  );
});

/**
 * 🛑 THREE DIFFERENT STATES GIVE A NULL FILL, AND THE MODAL MEETS ALL THREE.
 * A vendor with no window, a handle that has never reported, and a row whose
 * last report went stale. `gateRisk` compares a threshold against this number,
 * so a null has to stay a null rather than becoming a zero.
 */
test("🛑 a STALE row resolves a null fill even though it HAS used and total", () => {
  const stale = {
    handle: "cursor-d",
    context_gate: 40,
    context_gate_source: "override",
    context_used: 90_000,
    context_total: 200_000,
    fresh: false,
  };

  const got = gateTargetFor("cursor-d", { agents: [], peers: [stale] });

  assert.equal(got?.fillPercent, null, "a stale row reported a fill");
  // The denominator: the SAME row with `fresh: true` must give a number, or
  // this test passes against a resolver that never reads the fill at all.
  assert.equal(
    gateTargetFor("cursor-d", {
      agents: [],
      peers: [{ ...stale, fresh: true }],
    })?.fillPercent,
    45,
  );
});

test("an unknown handle resolves to null rather than a half-filled object", () => {
  assert.equal(
    gateTargetFor("nobody", { agents: [AGENT_ROW], peers: [PEER_ROW] }),
    null,
  );
  // The denominator: the same call with a KNOWN handle must not be null, or
  // this test passes against a resolver that returns null for everything.
  assert.notEqual(
    gateTargetFor("cursor-b", { agents: [AGENT_ROW], peers: [PEER_ROW] }),
    null,
  );
});

test("missing or malformed state resolves null instead of throwing", () => {
  assert.equal(gateTargetFor("x"), null);
  assert.equal(gateTargetFor("x", {}), null);
  assert.equal(gateTargetFor("x", { agents: null, peers: null }), null);
});
