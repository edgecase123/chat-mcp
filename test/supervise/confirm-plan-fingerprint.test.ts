import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 🛑 BEFORE any import that resolves a state path.
process.env.CHAT_MCP_HOME = mkdtempSync(
  join(tmpdir(), "chat-mcp-fingerprint-"),
);

const {
  confirmVerdict,
  markConfirmed,
  diffPlans,
  describeChanges,
  envValuesDigest,
  PLAN_FIELD_KEYS,
} = await import("../../src/supervise/container.js");

const { registerMount } = await import("../../src/supervise/mounts.js");

import type { ContainerPlan } from "../../src/supervise/container.js";
import { containerPlan } from "../support/container-plan.js";

const plan = (over: Partial<ContainerPlan> = {}): ContainerPlan =>
  // #356 — no override in this factory, so one stable digest serves it.
  containerPlan({ envValuesDigest: envValuesDigest(undefined), ...over });

function statePath(): string {
  return join(process.env.CHAT_MCP_HOME!, "container.json");
}

/* ==========================================================================
 * lee's ruling, 2026-11-20: option A.
 * ======================================================================= */

test("a handle with nothing on file is unseen, not confirmed", () => {
  assert.deepEqual(confirmVerdict("fresh", plan()), { kind: "unseen" });
});

/**
 * 🛑 lee RULED A. A `confirmed[handle] === true` written before this slice
 * records WHICH plan was approved nowhere, so it cannot be compared to
 * anything. Treating it as confirmed would bless an override written after
 * the original confirm — the exact defect this slice exists to close.
 */
test("🛑 a legacy boolean true is NOT confirmed, so the handle re-prompts once", () => {
  writeFileSync(
    statePath(),
    JSON.stringify({ builtHash: null, confirmed: { old: true } }),
  );

  assert.deepEqual(confirmVerdict("old", plan()), { kind: "legacy" });
});

test("⚠️ control — a legacy entry for ANOTHER handle leaves this one unseen", () => {
  writeFileSync(
    statePath(),
    JSON.stringify({ builtHash: null, confirmed: { old: true } }),
  );

  assert.deepEqual(confirmVerdict("other", plan()), { kind: "unseen" });
});

/* ==========================================================================
 * The stored plan.
 * ======================================================================= */

test("the same plan stored and re-read is confirmed", () => {
  markConfirmed("same", plan());

  assert.deepEqual(confirmVerdict("same", plan()), { kind: "confirmed" });
});

/**
 * 🛑 THE PLAN IS STORED, NOT A HASH. A hash can say "something changed"; only
 * the plan can say the image WAS `chat-mcp-agent:local`. The verdict carries
 * the old value, which is the whole reason the store is not a digest.
 */
test("🛑 a changed image names the OLD value, not merely that something changed", () => {
  markConfirmed("img", plan({ image: "chat-mcp-agent:local" }));

  assert.deepEqual(confirmVerdict("img", plan({ image: "evil:latest" })), {
    kind: "changed",
    changes: [
      { field: "image", from: "chat-mcp-agent:local", to: "evil:latest" },
    ],
  });
});

test("⚠️ control — an unchanged field produces no entry in the diff", () => {
  assert.deepEqual(diffPlans(plan(), plan()), []);
});

test("🛑 every changed field is named, not just the first one found", () => {
  const before = plan();
  const after = plan({
    mountPaths: ["/work", "/extra"],
    envVarNames: ["CLAUDE_CODE_OAUTH_TOKEN", "GH_TOKEN"],
    binary: "cursor-agent",
    networkMode: "none",
    image: "other:tag",
    memory: "512m",
    installMemory: "1g",
    cpus: "0.5",
    installCpus: "1",
  });

  assert.deepEqual(
    diffPlans(before, after).map((c) => c.field),
    ["mounts", "env vars", "binary", "network", "image", "memory", "cpus"],
  );
});

/**
 * 🛑 AN ARRAY IS NOT COMPARED BY IDENTITY. A mount added after the confirm is
 * the containment hole this gate exists to catch, and `before !== after` on
 * two arrays is true for every plan ever built.
 */
test("🛑 a mount added after the confirm is named", () => {
  const changes = diffPlans(plan(), plan({ mountPaths: ["/work", "/etc"] }));

  assert.deepEqual(changes, [
    { field: "mounts", from: '["/work"]', to: '["/work","/etc"]' },
  ]);
});

/**
 * 🛑 THE DIFF READS LIKE THE BANNER. `null` is the absent cap, and the banner
 * prints it as `no limit`. A diff that said `null` would be describing the
 * data structure rather than the thing the operator approved.
 */
test("🛑 a cap removed after the confirm reads as `no limit`, never as null", () => {
  const changes = diffPlans(plan({ memory: "512m" }), plan({ memory: null }));

  assert.deepEqual(changes, [
    { field: "memory", from: "512m", to: "no limit" },
  ]);
});

/**
 * ⚠️ THE INSTALL CONTAINER FOLDS INTO ITS OWN LINE. `installMemory` is
 * derived from `memory`, so diffing it separately would report ONE operator
 * decision as TWO changes.
 */
test("⚠️ a raised install cap is part of the memory line, not a change of its own", () => {
  const changes = diffPlans(
    plan({ memory: "4g", installMemory: "4g" }),
    plan({ memory: "512m", installMemory: "1g" }),
  );

  assert.deepEqual(changes, [
    { field: "memory", from: "4g", to: "512m (dependency install: 1g)" },
  ]);
});

/**
 * 🛑 THE DIFF'S COVERAGE IS ASSERTED, NOT ASSUMED. A field added to
 * `ContainerPlan` that the diff does not read is a change the operator is
 * never shown — and nothing else in the suite can see that.
 */
test("🛑 every ContainerPlan field is read by the diff", () => {
  assert.deepEqual(
    [...PLAN_FIELD_KEYS].sort(),
    Object.keys(plan()).sort(),
    "a ContainerPlan field is not covered by any diff line",
  );
});

/* ==========================================================================
 * Storing, and the re-prompt text.
 * ======================================================================= */

test("markConfirmed replaces a legacy boolean rather than merging into it", () => {
  writeFileSync(
    statePath(),
    JSON.stringify({ builtHash: null, confirmed: { grow: true } }),
  );
  markConfirmed("grow", plan({ image: "pinned:1" }));

  assert.deepEqual(confirmVerdict("grow", plan({ image: "pinned:1" })), {
    kind: "confirmed",
  });
});

test("confirming one handle does not confirm another", () => {
  markConfirmed("a", plan());

  assert.deepEqual(confirmVerdict("b", plan()), { kind: "unseen" });
});

/**
 * 🛑 FAILS CLOSED ON A PLAN IT CANNOT READ. A plan written by an older build,
 * missing a field this one diffs, must re-prompt. Reading the gap as "equal"
 * is the fails-open direction.
 */
test("🛑 a stored plan missing a field re-prompts rather than reading absent as equal", () => {
  const stored = { ...plan() } as unknown as Record<string, unknown>;
  delete stored.image;
  writeFileSync(
    statePath(),
    JSON.stringify({ builtHash: null, confirmed: { partial: stored } }),
  );

  const verdict = confirmVerdict("partial", plan());

  assert.equal(verdict.kind, "changed");
  assert.deepEqual(
    verdict.kind === "changed" ? verdict.changes : [],
    [{ field: "image", from: "(not recorded)", to: "chat-mcp-agent:local" }],
    "an absent stored field must read as changed",
  );
});

test("describeChanges names each change on its own line", () => {
  const text = describeChanges([
    { field: "image", from: "a", to: "b" },
    { field: "mounts", from: "/work", to: "/work, /etc" },
  ]);

  assert.match(text, /image: a -> b/);
  assert.match(text, /mounts: \/work -> \/work, \/etc/);
  assert.equal(text.trim().split("\n").length, 2);
});

/* ==========================================================================
 * 🔴 A JOINED STRING IS NOT A COMPARISON. Found by claude2 on PR 352.
 * ======================================================================= */

/**
 * 🔴 THE GATE SAID `confirmed` WHILE THE CONTAINER GAINED TWO HOST
 * DIRECTORIES. Comparing `mountPaths.join(", ")` compares one flattened
 * string, so a mount key containing `", /mnt/"` makes two different mount
 * sets render identically.
 *
 * 🛑 THE KEY IS UNVALIDATED BY DESIGN. `mounts.ts` calls it "a free-form slug
 * the AGENT's own convention gives meaning to", and `registerMount` checks
 * only that the directory exists and sits outside the state dir. So this
 * needs no hand-edited state file to reach.
 */
test("🔴 two different mount sets that JOIN identically are not confirmed", () => {
  const changes = diffPlans(
    plan({ mountPaths: ["/work", "/mnt/a, /mnt/b"] }),
    plan({ mountPaths: ["/work", "/mnt/a", "/mnt/b"] }),
  );

  assert.equal(changes.length, 1, "the swap must be reported as a change");
  assert.equal(changes[0]!.field, "mounts");
  assert.notEqual(
    changes[0]!.from,
    changes[0]!.to,
    "a change whose from and to render the same tells the operator nothing",
  );
});

/**
 * ⚠️ CONTROL — the comparison did not become "always different". Two lists
 * that are genuinely equal must still confirm, or the gate refuses every
 * start and the test above would pass for the wrong reason.
 */
test("⚠️ control — an identical mount list still compares equal", () => {
  assert.deepEqual(
    diffPlans(
      plan({ mountPaths: ["/work", "/mnt/a"] }),
      plan({ mountPaths: ["/work", "/mnt/a"] }),
    ),
    [],
  );
});

/**
 * ⚠️ THE SAME HOLE THROUGH `envVarNames`. It is built from the vendor today
 * and no operator writes it, so this is a guard against that changing rather
 * than a reachable defect now.
 */
test("⚠️ two env var name lists that JOIN identically are not confirmed", () => {
  const changes = diffPlans(
    plan({ envVarNames: ["A, B"] }),
    plan({ envVarNames: ["A", "B"] }),
  );

  assert.equal(changes.length, 1);
  assert.equal(changes[0]!.field, "env vars");
});

/**
 * 🛑 THE REACHABILITY PREMISE, PINNED SEPARATELY. The collision test above
 * uses a hand-built plan, so on its own it cannot say whether an operator can
 * actually produce the colliding list. `registerMount` validates the
 * DIRECTORY and never the KEY, which is what makes this a real bypass rather
 * than a theoretical one.
 *
 * ⚠️ IF KEY VALIDATION IS EVER ADDED, this test is the one that should fail
 * first — and only then is the joined comparison safe again.
 */
test("🛑 registerMount accepts a key containing the separator the diff used", () => {
  const handle = `collide-${process.pid}`;
  const dir = mkdtempSync(join(tmpdir(), "chat-mcp-collide-"));

  const mounts = registerMount(handle, "a, /mnt/b", dir);

  assert.ok(
    Object.keys(mounts).includes("a, /mnt/b"),
    "the key is stored verbatim, so the joined form was operator-reachable",
  );
});
