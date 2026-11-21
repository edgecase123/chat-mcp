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
  PLAN_FIELD_KEYS,
} = await import("../../src/supervise/container.js");

import type { ContainerPlan } from "../../src/supervise/container.js";

function plan(over: Partial<ContainerPlan> = {}): ContainerPlan {
  return {
    mountPaths: ["/work"],
    envVarNames: ["CLAUDE_CODE_OAUTH_TOKEN"],
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
    { field: "mounts", from: "/work", to: "/work, /etc" },
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
