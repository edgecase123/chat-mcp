import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 🛑 BEFORE any import that resolves a state path.
process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), "chat-mcp-floor-src-"));

const { overridePathFor, overridesDir } =
  await import("../../src/util/paths.js");

import type { VendorSpawn } from "../../src/supervise/vendor.js";

const vendor = {
  image: "chat-mcp-agent:local",
  binary: "claude",
  authEnvVar: "CLAUDE_CODE_OAUTH_TOKEN",
} as unknown as VendorSpawn;

/** A cap below #346's floor, so a duplicated floor would produce `1g` / `1`. */
function belowFloor(handle: string): string {
  mkdirSync(overridesDir(), { recursive: true });
  writeFileSync(
    overridePathFor(handle),
    JSON.stringify({ memory: "512m", cpus: "0.5" }),
  );
  return handle;
}

/* ==========================================================================
 * 🟡 WHY THIS FILE EXISTS, instead of a comment claiming the same thing.
 *
 * `confirm-plan.test.ts` asserts the banner's install values EQUAL the install
 * argv's. That catches a floor that DRIFTS and cannot catch one that is
 * COPIED: a re-duplicated `"1g"` agrees by construction. claude2 measured it
 * on PR 349 — a second copy of the floor inside `confirmPlan.ts` survived all
 * 15 tests, typecheck and the full suite.
 *
 * 🛑 SO THE TEST MUST PIN THE SOURCE, NOT THE VALUE. Replacing the exported
 * function makes the banner follow it only if the banner actually calls it.
 * A copy ignores the replacement and keeps printing the real floor.
 * ======================================================================= */

test("🛑 the banner's install values come from installResources, not a copy of its floor", async (t) => {
  const real = await import("../../src/supervise/installResources.js");

  t.mock.module("../../src/supervise/installResources.js", {
    namedExports: {
      ...real,
      installMemoryFor: () => "SENTINEL-MEM",
      installCpusFor: () => "SENTINEL-CPU",
    },
  });

  const { buildConfirmPlan } =
    await import("../../src/supervise/confirmPlan.js");
  const plan = buildConfirmPlan(vendor, belowFloor(`src-mem-${process.pid}`));

  assert.equal(
    plan.installMemory,
    "SENTINEL-MEM",
    "a second copy of the floor would print 1g and ignore this",
  );
  assert.equal(plan.installCpus, "SENTINEL-CPU");
});

/* ⚠️ THE PAIRED CONTROL IS IN `confirm-plan.test.ts`, NOT HERE, and that is
 * deliberate. `t.mock.module` leaves the mocked `confirmPlan` in this
 * process's module cache, so an unmocked assertion in this FILE would read
 * the sentinel too — it passed against `SENTINEL-MEM` when it lived here.
 *
 * The control that matters already runs in its own process:
 *   `🛑 a cap BELOW the install floor is named as raised, not printed bare`
 * asserts `memory: 512m (dependency install: 1g)` with nothing mocked. So the
 * sentinel above cannot be what production returns.
 */
