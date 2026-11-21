import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CHAT_MCP_HOME = mkdtempSync(
  join(tmpdir(), "chat-mcp-per-vendor-gate-"),
);

const { migrate } = await import("../../src/storage/db.js");
const { startSupervisor } = await import("../../src/supervise/index.js");
const { setVendorToken } = await import("../../src/supervise/auth.js");
const { claudeSpawn } = await import("../../src/adapters/claude-spawn.js");
const { cursorSpawn } = await import("../../src/adapters/cursor-spawn.js");
import { supervisorOptions } from "../support/supervisor-options.js";
import { confirmHandle } from "../support/confirm-plan.js";

/**
 * 🛑 THE OTHER REFUSAL SITE. `dockerRunPlan` refuses at SPAWN time and
 * `startSupervisor` refuses at START time, and the two carry the same message
 * — so no assertion on the text can tell them apart.
 *
 * **The discriminator is ORDER.** The start-time check runs before the
 * container confirmation gate, which is the property its own comment claims:
 * a throw at spawn time leaves the handle with no agent and no remedy.
 *
 * So an UNCONFIRMED handle with no Cursor credential must fail on the
 * credential. Reverted to the shared `readToken()`, the Claude token on file
 * satisfies the check, execution falls through, and the error becomes
 * `not confirmed` instead.
 *
 * Raised by claude1 on PR 354, whose negative control restored
 * `containerized.ts` alone and therefore said nothing about this site.
 */
test("🛑 the credential is refused at START, before the confirmation gate", async () => {
  const db = new DatabaseSync(":memory:");
  migrate(db);

  // On file for the OTHER vendor, which is the whole defect: one token used to
  // satisfy every vendor's check.
  setVendorToken(claudeSpawn, "sk-ant-oat-x");

  await assert.rejects(
    () =>
      startSupervisor(
        supervisorOptions({
          handle: `pvg-${process.pid}-unconfirmed`,
          db,
          vendor: cursorSpawn,
          extraDirs: [process.cwd()],
          driver: "docker-cursor",
          reply: false,
          log: () => undefined,
        }),
      ),
    (err: Error) => {
      assert.match(err.message, /CURSOR_API_KEY/);
      // The discriminator. Without it this test passes on the gate's own
      // refusal and says nothing about which check ran first.
      assert.doesNotMatch(err.message, /not confirmed/);
      return true;
    },
  );
});

/**
 * The paired control. A start-time check that refused every vendor outright
 * would pass the test above and break the vendor that works today.
 */
test("a confirmed Cursor handle with its own key gets past the credential check", async () => {
  const db = new DatabaseSync(":memory:");
  migrate(db);

  const handle = `pvg-${process.pid}-confirmed`;

  setVendorToken(claudeSpawn, "sk-ant-oat-x");
  setVendorToken(cursorSpawn, "key_cursor-x");
  confirmHandle(handle, cursorSpawn);

  // It still fails — nothing builds the Cursor image yet (#317 unit 3) — but
  // the failure must no longer be about the credential.
  await assert.rejects(
    () =>
      startSupervisor(
        supervisorOptions({
          handle,
          db,
          vendor: cursorSpawn,
          extraDirs: [process.cwd()],
          driver: "docker-cursor",
          reply: false,
          log: () => undefined,
        }),
      ),
    (err: Error) => {
      assert.doesNotMatch(err.message, /CURSOR_API_KEY on file/);
      return true;
    },
  );
});
