import { test } from "node:test";
import assert from "node:assert/strict";
import { gateSubmission, gateRisk } from "../../web/assets/logic.js";

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
    assert.notEqual(
      risk,
      null,
      `gate ${gate} under a 20% fill gave no warning`,
    );
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
  assert.notEqual(risk, null, "gate == fill was treated as safe");
  assert.equal(risk.severity, "silent", "gate == fill was downgraded to soon");
});

/**
 * ⚠️ A GATE JUST ABOVE THE FILL IS A DIFFERENT, MILDER CASE and must not
 * borrow the silence wording. It fires soon, which is often what the operator
 * wants.
 */
test("a gate just above the current fill warns that it fires SOON, not that it silences", () => {
  const risk = gateRisk(23, 20);
  assert.notEqual(risk, null, "a 3-point margin gave no note at all");
  assert.equal(risk.severity, "soon");
  assert.doesNotMatch(risk.message, /nothing will restart|never restart/i);
});

test("the two severities are distinct, so the UI can style them apart", () => {
  assert.equal(gateRisk(10, 20).severity, "silent");
  assert.equal(gateRisk(23, 20).severity, "soon");
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
