import { buildConfirmPlan } from "../../src/supervise/confirmPlan.js";
import { markConfirmed } from "../../src/supervise/container.js";
import { claudeSpawn } from "../../src/adapters/claude-spawn.js";
import type { VendorSpawn } from "../../src/supervise/vendor.js";

/**
 * Satisfy the container gate for a handle, by storing the plan the supervisor
 * will actually build for it.
 *
 * 🛑 IT BUILDS THE PLAN RATHER THAN TAKING ONE. The gate compares the stored
 * plan to `buildConfirmPlan`'s output, so a hand-written plan here would
 * confirm a handle the supervisor then refuses — and the test would read as a
 * gate bug. Any override on file is picked up, because `buildConfirmPlan`
 * reads it.
 *
 * ⚠️ CALL IT AFTER WRITING THE OVERRIDE. The plan is captured when this runs,
 * which is the same ordering an operator has at the prompt.
 */
export function confirmHandle(handle: string, vendor?: VendorSpawn): void {
  markConfirmed(handle, buildConfirmPlan(vendor ?? claudeSpawn, handle));
}
