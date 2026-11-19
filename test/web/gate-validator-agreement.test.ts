import { test } from "node:test";
import assert from "node:assert/strict";
import { gateSubmission } from "../../web/assets/logic.js";
import { isLegalGate } from "../../src/storage/context-gate.js";

/**
 * #322 unit 2 — the browser validator may never be LAXER than the server one.
 *
 * `gateSubmission` (browser) and `isLegalGate` (storage) both decide what a
 * legal gate is, in two languages, with no shared code. Before this file their
 * agreement was asserted only in prose, in two docblocks and one test comment.
 *
 * 🛑 ONLY ONE DIRECTION IS A DEFECT, AND IT IS THE ONE PINNED HERE:
 *
 *   browser ok  ==>  server legal      PINNED. the other way is a 400 the
 *                                      operator gets after a round trip.
 *   server legal ==> browser ok        NOT pinned, deliberately. `+50` `50.0`
 *                                      `1.` `1e2` `1E2` `0x10` `0b11` are all
 *                                      refused in the box and legal as
 *                                      numbers, and refusing them inline is
 *                                      better UX than storing 16 for `0x10`.
 *
 * ⚠️ THIS PASSES TRIVIALLY ON TODAY'S CODE, BY CONSTRUCTION. `gateSubmission`
 * returns `ok` only for `/^\d+$/` in 1..100, which is exactly `isLegalGate`'s
 * domain. The guard is against a FUTURE loosening of the box — accepting `0`,
 * a fraction, or a leading `+` — which silently moves a refusal out of the
 * browser and into the route.
 */

/** Every integer either side of the legal window, as a plain decimal string. */
const DECIMALS = Array.from({ length: 111 }, (_, i) => String(i - 5));

/**
 * Shapes a looser box might start accepting. Each is a different reason to
 * refuse, so a single clause going missing shows up as one row and not as a
 * whole group.
 */
const SHAPES = [
  "",
  "   ",
  " 42 ",
  "+50",
  "-50",
  "50.0",
  "50.5",
  "1.",
  ".5",
  "1e2",
  "1E2",
  "0x10",
  "0b11",
  "0o10",
  "1_0",
  "50%",
  "50 ",
  "abc",
  "NaN",
  "Infinity",
  "null",
  "undefined",
  "true",
  "١٠",
  "５０",
  "50\n",
  "5 0",
  "００５０",
  "0.0000000001",
  "1e-7",
  "99999999999999999999",
  "-0",
];

const CORPUS = [...DECIMALS, ...SHAPES];
const SCOPES = ["handle", "global"] as const;

/**
 * 🛑 THE DENOMINATOR IS ASSERTED, NOT ASSUMED. A corpus that silently stopped
 * being built would make every property below vacuously true, and the counts
 * are what distinguish "no violations" from "nothing was examined".
 */
test("no input the browser accepts as a number is illegal to the server", () => {
  let examined = 0;
  let okNumber = 0;
  let clear = 0;
  let refused = 0;
  let globalRefusedEmpty = 0;

  for (const scope of SCOPES) {
    for (const raw of CORPUS) {
      examined += 1;
      const out = gateSubmission(raw, { scope });

      if (!out.ok) {
        refused += 1;
        if (scope === "global" && String(raw).trim() === "")
          globalRefusedEmpty += 1;
        continue;
      }

      if (out.gate === null) {
        clear += 1;
        // A clear is legal for a handle and refused for the global, and it is
        // reachable ONLY by an empty box. Any other input arriving here means
        // the carve-out has widened into a hole this property cannot see.
        assert.equal(
          String(raw).trim(),
          "",
          `scope ${scope}: ${JSON.stringify(raw)} was accepted as a CLEAR`,
        );
        assert.equal(scope, "handle", "the global default was cleared");
        continue;
      }

      okNumber += 1;
      assert.ok(
        isLegalGate(out.gate),
        `scope ${scope}: the box accepted ${JSON.stringify(raw)} as ` +
          `${out.gate}, which isLegalGate rejects`,
      );
    }
  }

  assert.equal(examined, CORPUS.length * SCOPES.length);
  assert.equal(
    okNumber + clear + refused,
    examined,
    "a row was double-counted",
  );

  // 🛑 THE POSITIVE CONTROL. Without it a gateSubmission that refused
  // EVERYTHING would satisfy the property above and report green.
  assert.ok(okNumber > 0, "no input reached the ok-with-a-number branch");

  // 🛑 AND THE SCOPE AXIS IS PINNED BY ITS CONSEQUENCE, NOT BY THE ARRAY.
  // `SCOPES` cut to `["handle"]` kept `examined` consistent — it is the same
  // tautology one axis out — and silently stopped exercising the branch that
  // refuses a global clear. claude1 measured that on PR 328.
  assert.ok(clear > 0, "no scope reached the clear branch");
  assert.ok(
    globalRefusedEmpty > 0,
    "the global scope never refused an empty box",
  );
});

/**
 * 🛑 THE EXACT ACCEPTED SET, NOT A FLOOR. A floor one below the live count
 * admits exactly the one-element shrink a drifted matcher produces, which has
 * cost this repo three fail-open guards. `1..100` is derived from
 * `isLegalGate`'s own range, so it moves when the range moves.
 */
test("the box accepts exactly the 100 decimals the server calls legal", () => {
  const accepted = DECIMALS.filter(
    (raw) => gateSubmission(raw, { scope: "handle" }).gate !== null,
  ).filter((raw) => gateSubmission(raw, { scope: "handle" }).ok);

  const legal = DECIMALS.filter((raw) => isLegalGate(Number(raw)));

  assert.deepEqual(accepted, legal);
  assert.equal(accepted.length, 100);
});

/**
 * 🛑 THE CORPUS IS ASSERTED, NOT ONLY ITS TOTAL. `examined` compared against
 * `CORPUS.length * SCOPES.length` is a TAUTOLOGY — it holds for an empty
 * corpus too. Emptying `SHAPES` alone left the file reporting 2 of 2, because
 * the decimals kept the positive control satisfied. claude1 measured that on
 * PR 328 and it is the reason this test exists.
 *
 * ⚠️ A LENGTH ALONE DOES NOT CLOSE IT EITHER. Thirty-two copies of `"abc"` is
 * still thirty-two, so the shapes whose refusal the PR body reasons about are
 * named here rather than counted.
 */
test("the corpus is the one the property was measured against", () => {
  assert.equal(DECIMALS.length, 111);
  assert.deepEqual([DECIMALS[0], DECIMALS.at(-1)], ["-5", "105"]);

  assert.equal(SHAPES.length, 32);
  assert.equal(new Set(SHAPES).size, SHAPES.length, "a shape is duplicated");

  // The seven inputs the browser refuses and the server would call legal, plus
  // the empty box. Each one leaving the corpus removes a reason this file
  // deliberately does NOT pin the converse direction.
  for (const raw of ["", "+50", "50.0", "1.", "1e2", "1E2", "0x10", "0b11"]) {
    assert.ok(SHAPES.includes(raw), `${JSON.stringify(raw)} left the corpus`);
  }

  // 🛑 AND `CORPUS` MUST STILL BE ITS TWO HALVES. Asserting the halves is not
  // asserting what the property above actually iterates: a `.map()` or a
  // `.filter()` at the join gutted the corpus while every line above stayed
  // green, measured as mutant V3 on PR 328.
  assert.equal(CORPUS.length, DECIMALS.length + SHAPES.length);
  for (const raw of [...DECIMALS, ...SHAPES]) {
    assert.ok(CORPUS.includes(raw), `${JSON.stringify(raw)} is not in CORPUS`);
  }

  // Sorted, because the ORDER of the two scopes carries nothing and pinning it
  // would fail on a harmless edit.
  assert.deepEqual([...SCOPES].sort(), ["global", "handle"]);
});
