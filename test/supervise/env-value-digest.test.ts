import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 🛑 BEFORE any import that resolves a state path.
process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), "chat-mcp-env-digest-"));

const {
  confirmVerdict,
  markConfirmed,
  diffPlans,
  describeChanges,
  describePlan,
  envValuesDigest,
} = await import("../../src/supervise/container.js");

import type { ContainerPlan } from "../../src/supervise/container.js";

/**
 * #356 — the consent gate stored env var NAMES only.
 *
 * 🛑 A VALUE THAT MOVED PRODUCED A BYTE-IDENTICAL PLAN, so the gate read it as
 * already confirmed and the container ran a value nobody had approved. The
 * operator approved a NAME and believed they had approved what it held.
 *
 * lee ruled it on 2026-11-21: *"Yes it should. Security first."*
 */

const SECRET = "hunter2-the-original-value";
const ROTATED = "hunter3-somebody-changed-it";

function plan(over: Partial<ContainerPlan> = {}): ContainerPlan {
  return {
    mountPaths: ["/work"],
    envVarNames: ["CLAUDE_CODE_OAUTH_TOKEN", "MY_VAR"],
    envValuesDigest: envValuesDigest({ MY_VAR: SECRET }),
    binary: "claude",
    networkMode: "bridge",
    image: "chat-mcp-agent:local",
    memory: null,
    cpus: null,
    installMemory: null,
    installCpus: null,
    ...over,
  };
}

/* ==========================================================================
 * The defect itself.
 * ======================================================================= */

/**
 * 🛑 THE HEADLINE CASE. Same name, same everything else, different value.
 */
test("a changed env VALUE re-prompts, though every name is identical", () => {
  markConfirmed("rotate", plan());

  const verdict = confirmVerdict(
    "rotate",
    plan({ envValuesDigest: envValuesDigest({ MY_VAR: ROTATED }) }),
  );

  assert.equal(verdict.kind, "changed");
});

/**
 * ⚠️ THE CO-PRIMARY CONTROL, and the test above cannot fail without it: a gate
 * that re-prompted on everything would satisfy it perfectly.
 */
test("⚠️ control — an unchanged value stays confirmed", () => {
  markConfirmed("same", plan());

  assert.deepEqual(confirmVerdict("same", plan()), { kind: "confirmed" });
});

/**
 * 🛑 A PLAN STORED BEFORE THIS FIELD EXISTED MUST RE-PROMPT, NOT PASS. An
 * absent field read as equal is the fails-OPEN direction, and 14 such plans
 * are on this laptop's disk today.
 */
test("🛑 a stored plan with no digest at all re-prompts", () => {
  const { envValuesDigest: _drop, ...legacy } = plan();

  writeFileSync(
    join(process.env.CHAT_MCP_HOME!, "container.json"),
    JSON.stringify({
      builtHash: null,
      builtHashes: {},
      confirmed: { older: legacy },
    }),
  );

  assert.equal(confirmVerdict("older", plan()).kind, "changed");
});

/* ==========================================================================
 * The digest must not become a disclosure surface.
 * ======================================================================= */

/**
 * 🛑 THE VALUE NEVER REACHES THE PLAN. The plan is written to disk and shown to
 * an operator, so a value in it is a value in both places.
 */
test("🛑 neither the stored plan nor the banner carries the value", () => {
  const p = plan();

  assert.doesNotMatch(JSON.stringify(p), /hunter2/);
  assert.doesNotMatch(describePlan(p), /hunter2/);
});

/**
 * 🛑 AND THE RE-PROMPT MUST NOT CARRY THE DIGEST EITHER. A truncated hash of a
 * low-entropy value is guessable offline, and the re-prompt is the one place
 * this field would otherwise be printed — `describePlan` never shows it, but
 * `describeChanges` prints every changed field's from and to.
 *
 * ⚠️ WHAT THE OPERATOR NEEDS IS THE CATEGORY, NOT THE BYTES. "a value moved" is
 * actionable; two hex strings are not.
 */
test("🛑 the re-prompt names the change without printing the digest", () => {
  const before = plan();
  const after = plan({
    envValuesDigest: envValuesDigest({ MY_VAR: ROTATED }),
  });

  const changes = diffPlans(before, after);
  const text = describeChanges(changes);

  assert.equal(changes.length, 1, `expected one change, got ${changes.length}`);
  assert.match(text, /env var values/i);
  assert.doesNotMatch(text, new RegExp(before.envValuesDigest));
  assert.doesNotMatch(text, new RegExp(after.envValuesDigest));
  assert.doesNotMatch(text, /hunter/);
});

/**
 * 🛑 `(not recorded)` MUST SURVIVE REDACTION, and my own comment claimed it
 * without a test. It is not derived from the secret, and it is the only part of
 * a legacy re-prompt an operator can act on — "this moved" and "this was never
 * stored" call for different responses.
 */
test("🛑 a never-recorded digest says so, rather than reading as redacted", () => {
  const { envValuesDigest: _drop, ...legacy } = plan();

  const changes = diffPlans(legacy, plan());
  const line = changes.find((c) => c.field === "env var values");

  assert.notEqual(line, undefined, "the absent field produced no change");
  assert.equal(line!.from, "(not recorded)");
  assert.equal(line!.to, "(not shown)");
});

/* ==========================================================================
 * The digest itself.
 * ======================================================================= */

/**
 * 🛑 KEY ORDER IS NOT A CHANGE. An override file rewritten with its keys in a
 * different order would otherwise re-prompt for nothing, and a gate that cries
 * wolf is a gate an operator learns to click through.
 */
test("🛑 the digest is independent of key order", () => {
  assert.equal(
    envValuesDigest({ A: "1", B: "2" }),
    envValuesDigest({ B: "2", A: "1" }),
  );
});

/**
 * ⚠️ THE CONTROL FOR THE TEST ABOVE. A digest that ignored its input entirely
 * would satisfy order-independence perfectly.
 */
test("⚠️ control — a different value IS a different digest", () => {
  assert.notEqual(envValuesDigest({ A: "1" }), envValuesDigest({ A: "2" }));
  assert.notEqual(envValuesDigest({ A: "1" }), envValuesDigest({ B: "1" }));
  assert.notEqual(envValuesDigest({}), envValuesDigest({ A: "1" }));
});

/**
 * 🛑 THE NAME IS HASHED WITH ITS VALUE, AND A RENAME IS WHAT PROVES IT. Moving
 * the same value to a different variable is a real change — a token that was
 * `GH_TOKEN` and is now `MY_VAR` reaches different code inside the container.
 *
 * ⚠️ I WROTE THE WRONG TEST FOR THIS FIRST. A SWAP (`{A:1,B:2}` ->
 * `{A:2,B:1}`) passes even when only the values are hashed, because sorting by
 * key still yields `["1","2"]` against `["2","1"]`. Measured with that exact
 * mutant. A RENAME is the case that collapses without the names.
 */
test("🛑 the same value under a different name is a change", () => {
  assert.notEqual(envValuesDigest({ A: "1" }), envValuesDigest({ B: "1" }));
});

/**
 * Two credentials swapped between their names. Weaker than the rename above —
 * it survives a values-only digest — but it is the shape an operator would
 * most expect to be caught, so it is pinned rather than assumed.
 */
test("swapping two values between their names is a change", () => {
  assert.notEqual(
    envValuesDigest({ A: "1", B: "2" }),
    envValuesDigest({ A: "2", B: "1" }),
  );
});

/**
 * ⚠️ NO OVERRIDE AT ALL IS THE COMMON CASE and must be a stable, recorded
 * value rather than an empty string that reads as "not recorded".
 */
test("an absent override env is a real digest, not an empty string", () => {
  const none = envValuesDigest(undefined);

  assert.equal(none, envValuesDigest({}));
  assert.notEqual(none, "");
  assert.match(none, /^[0-9a-f]{16,}$/);
});

/* ==========================================================================
 * The plan is built from the override, not from a second copy of it.
 * ======================================================================= */

/**
 * 🛑 `buildConfirmPlan` MUST DIGEST THE SAME OVERRIDE IT NAMES. Reading the
 * override twice is how the banner and the spawn come to describe different
 * files — the mistake `image` and `memory` already carry a comment about.
 */
test("🛑 buildConfirmPlan digests the override it resolved", async () => {
  const home = process.env.CHAT_MCP_HOME!;
  mkdirSync(join(home, "overrides"), { recursive: true });
  writeFileSync(
    join(home, "agents.json"),
    JSON.stringify({
      agents: { withenv: { vendor: "claude", mode: "docker" } },
    }),
  );

  const { buildConfirmPlan } =
    await import("../../src/supervise/confirmPlan.js");
  const { resolveOverrideFor } =
    await import("../../src/supervise/overrideStore.js");

  const vendor = {
    authEnvVar: "CLAUDE_CODE_OAUTH_TOKEN",
    containerBinary: "claude",
    image: "chat-mcp-agent:local",
    vendor: "claude",
  } as never;

  const built = buildConfirmPlan(vendor, "withenv");
  const override = resolveOverrideFor("withenv");

  assert.equal(built.envValuesDigest, envValuesDigest(override?.env));
});

/* ==========================================================================
 * The three findings my own security-scanner raised on this PR.
 * ======================================================================= */

/**
 * 🛑 THE DIGEST IS AN HMAC, NOT A BARE HASH, BECAUSE IT LEAVES THE HOST.
 * `GET /api/agents/plan` echoes the whole plan to the dashboard. The names
 * travel in the same object and the serialisation is public, so an unsalted
 * hash leaves only the VALUES to search — and a short enum or a PIN falls to an
 * offline sweep. Under a per-install key, what the browser receives is not
 * invertible.
 *
 * ⚠️ TESTED BY DELETING THE KEY, NOT BY RE-IMPORTING THE MODULE. A
 * template-literal dynamic import is ratcheted at ten in
 * `typecheck-config.test.ts`, and an eleventh failed the gate. Deleting the
 * file is also the sharper instrument: it proves the digest depends on THAT
 * file rather than on something else that happens to vary per install.
 */
test("🛑 the digest is keyed, so losing the key changes every digest", () => {
  const keyPath = join(process.env.CHAT_MCP_HOME!, "env-digest-key");

  const before = envValuesDigest({ MY_VAR: SECRET });

  assert.ok(existsSync(keyPath), "no key file was minted");
  assert.equal(
    statSync(keyPath).mode & 0o777,
    0o600,
    "the key is readable by somebody other than its owner",
  );

  rmSync(keyPath);
  const after = envValuesDigest({ MY_VAR: SECRET });

  assert.notEqual(after, before, "the digest does not depend on the key");
  assert.match(after, /^[0-9a-f]{64}$/);
});

/**
 * ⚠️ THE CONTROL FOR THE TEST ABOVE. A digest that returned random bytes per
 * CALL would satisfy "differs across installs" perfectly and break the gate
 * entirely, so the same input under the same key must still be stable.
 */
test("⚠️ control — the digest is stable within one install", () => {
  assert.equal(
    envValuesDigest({ MY_VAR: SECRET }),
    envValuesDigest({ MY_VAR: SECRET }),
  );
});

/**
 * 🛑 THE CALLER'S OVERRIDE WINS, SO THE GATE AND THE SPAWN READ THE FILE ONCE.
 * `startSupervisor` resolves the override, then `buildConfirmPlan` resolved it
 * AGAIN — and the value the container receives is the caller's read while the
 * verdict came from ours. A write landing between them spawns an unapproved
 * value under a `confirmed` verdict.
 *
 * ⚠️ `null` IS A CALLER THAT LOOKED AND FOUND NOTHING, and must NOT fall
 * through to a second read. Only `undefined` may.
 */
test("🛑 buildConfirmPlan digests the override it was GIVEN, not the file", async () => {
  const home = process.env.CHAT_MCP_HOME!;
  mkdirSync(join(home, "overrides"), { recursive: true });
  writeFileSync(
    join(home, "agents.json"),
    JSON.stringify({
      agents: { given: { vendor: "claude", mode: "docker" } },
    }),
  );
  writeFileSync(
    join(home, "overrides", "given.json"),
    JSON.stringify({ env: { ON_DISK: "from-the-file" } }),
  );

  const { buildConfirmPlan } =
    await import("../../src/supervise/confirmPlan.js");

  const vendor = {
    authEnvVar: "CLAUDE_CODE_OAUTH_TOKEN",
    containerBinary: "claude",
    image: "chat-mcp-agent:local",
    vendor: "claude",
  } as never;

  const handed = buildConfirmPlan(vendor, "given", {
    env: { PASSED_IN: "from-the-argument" },
  } as never);

  assert.equal(
    handed.envValuesDigest,
    envValuesDigest({ PASSED_IN: "from-the-argument" }),
    "the file was re-read instead of using the argument",
  );
  assert.ok(handed.envVarNames.includes("PASSED_IN"));
  assert.ok(
    !handed.envVarNames.includes("ON_DISK"),
    "the names came from the file too, so the two halves disagree",
  );

  // ⚠️ `null` MUST NOT RE-READ. A default that fired on null would turn "I
  // looked, there is none" into the second read this argument exists to stop.
  const none = buildConfirmPlan(vendor, "given", null);

  assert.equal(none.envValuesDigest, envValuesDigest(undefined));
  assert.ok(!none.envVarNames.includes("ON_DISK"));

  // The co-primary control: OMITTING it still reads the file, because three
  // callers have no override in hand and that is correct for them.
  const read = buildConfirmPlan(vendor, "given");

  assert.ok(read.envVarNames.includes("ON_DISK"));
});
