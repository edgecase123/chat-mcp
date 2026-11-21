import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CHAT_MCP_HOME = mkdtempSync(
  join(tmpdir(), "chat-mcp-confirm-helper-"),
);

const { confirmHandle } = await import("./confirm-plan.js");
const { confirmVerdict } = await import("../../src/supervise/container.js");
const { buildConfirmPlan } = await import("../../src/supervise/confirmPlan.js");
const { claudeSpawn } = await import("../../src/adapters/claude-spawn.js");
const { overridePathFor, overridesDir } =
  await import("../../src/util/paths.js");

test("a handle the helper confirmed passes the gate", () => {
  const handle = `helper-${process.pid}`;

  confirmHandle(handle);

  assert.deepEqual(
    confirmVerdict(handle, buildConfirmPlan(claudeSpawn, handle)),
    { kind: "confirmed" },
  );
});

/**
 * 🛑 THE HELPER IS WHY THE GATE TESTS ARE NOT VACUOUS. If it stored a plan the
 * supervisor never builds, every caller would hit `changed` and read a gate
 * refusal as the behaviour under test.
 */
test("🛑 an override written BEFORE the helper runs is part of what it confirms", () => {
  const handle = `helper-ovr-${process.pid}`;
  mkdirSync(overridesDir(), { recursive: true });
  writeFileSync(overridePathFor(handle), JSON.stringify({ memory: "512m" }));

  confirmHandle(handle);

  assert.deepEqual(
    confirmVerdict(handle, buildConfirmPlan(claudeSpawn, handle)),
    { kind: "confirmed" },
  );
});

/**
 * ⚠️ CONTROL — the helper is not a blanket pass. An override written AFTER it
 * runs must still re-prompt, which is the defect the fingerprint exists to
 * catch.
 */
test("⚠️ control — an override written AFTER the helper runs is a CHANGE", () => {
  const handle = `helper-late-${process.pid}`;

  confirmHandle(handle);

  mkdirSync(overridesDir(), { recursive: true });
  writeFileSync(overridePathFor(handle), JSON.stringify({ memory: "512m" }));

  const verdict = confirmVerdict(handle, buildConfirmPlan(claudeSpawn, handle));

  assert.equal(verdict.kind, "changed");
  assert.deepEqual(verdict.kind === "changed" ? verdict.changes : [], [
    {
      field: "memory",
      from: "no limit",
      to: "512m (dependency install: 1g)",
    },
  ]);
});
