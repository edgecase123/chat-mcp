import { test } from "node:test";
import assert from "node:assert/strict";

import { arrived, arrivedAndStayed } from "./arrival.js";

/**
 * #305. The helper that replaced a fixed sleep in `activity.test.ts`.
 *
 * 🛑 A WAIT HELPER THAT NEVER FAILS IS WORSE THAN THE SLEEP IT REPLACED,
 * because every caller then reads as covered. The two timeout tests are the
 * ones that matter; the fast-path tests are their controls.
 */

/** A counter that reaches `to` after `afterMs`, driven by the clock only. */
function climbsTo(to: number, afterMs: number): () => number {
  const at = Date.now() + afterMs;

  return () => (Date.now() >= at ? to : 0);
}

test("🔴 arrived FAILS BY TIMEOUT when the thing never lands, and says how far it got", async () => {
  await assert.rejects(
    () => arrived(() => 1, { want: 3, deadlineMs: 50, label: "no tick" }),
    /only 1 of 3 arrived within 50ms — no tick/,
    "a count that never reaches the target resolved anyway",
  );
});

test("⚠️ control — arrived returns on arrival and does NOT spend the deadline", async () => {
  const began = Date.now();

  await arrived(climbsTo(1, 30), { deadlineMs: 5_000 });

  const spent = Date.now() - began;

  // The point of the deadline is that a PASSING run never pays it. A 30ms
  // arrival must not cost anything near the 5s budget.
  assert.ok(
    spent < 1_000,
    `a 30ms arrival spent ${String(spent)}ms, so the helper is sleeping rather than polling`,
  );
});

test("⚠️ control — an already-satisfied count returns without waiting", async () => {
  const began = Date.now();

  await arrived(() => 4, { want: 4 });

  assert.ok(Date.now() - began < 100, "a satisfied count still waited");
});

test("🔴 arrivedAndStayed FAILS when the count grows after the first arrival", async () => {
  let polls = 0;
  const count = () => {
    polls += 1;

    // 1 on the poll that satisfies it, then more during the quiet window.
    return polls < 2 ? 1 : 9;
  };

  await assert.rejects(
    () => arrivedAndStayed(count, { quietMs: 30, label: "flooded" }),
    /9 arrived where 1 was the whole budget, within 30ms of the first — flooded/,
    "an upper bound was declared met while the count was still climbing",
  );
});

test("⚠️ control — arrivedAndStayed passes when the count holds still", async () => {
  await arrivedAndStayed(() => 2, { want: 2, quietMs: 30 });
});
