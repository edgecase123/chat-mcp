import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 🛑 THE PREFIX IS SHORT ON PURPOSE — `chat-mcp-per-vendor-gate-` did not fit.
 *
 * The supervisor binds a unix socket at `<CHAT_MCP_HOME>/sock/<handle>`, and
 * `sun_path` caps that at 104 bytes on macOS. Under the old prefix the path
 * measured 104 with a four-digit pid and 105 with a five-digit one, so this
 * file bound a socket or threw `EINVAL` depending on which pid the kernel
 * happened to hand the test runner.
 */
process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), "chat-mcp-pvg-"));

const { migrate } = await import("../../src/storage/db.js");
const { startSupervisor } = await import("../../src/supervise/index.js");
const { setVendorToken } = await import("../../src/supervise/auth.js");
const { claudeSpawn } = await import("../../src/adapters/claude-spawn.js");
const { cursorSpawn } = await import("../../src/adapters/cursor-spawn.js");
import { supervisorOptions } from "../support/supervisor-options.js";
import { confirmHandle } from "../support/confirm-plan.js";

import type { SpawnOptions } from "../../src/supervise/child.js";

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

/** Every `SpawnOptions` the supervisor handed a driver, in call order. */
function recordingChild(seen: SpawnOptions[]) {
  return (opts: SpawnOptions) => {
    seen.push(opts);

    return {
      reportsUsage: false,
      reportsContext: false,
      send: () => undefined,
      onTurnEnd: () => undefined,
      onContext: () => undefined,
      onUsage: () => undefined,
      onDenial: () => undefined,
      onToolCall: () => undefined,
      onSession: (cb: (id: string) => void) => cb("sess-1"),
      onEvent: () => undefined,
      onStderr: () => undefined,
      onExit: () => undefined,
      kill: () => undefined,
    };
  };
}

/**
 * The paired control. A start-time check that refused every vendor outright
 * would pass the test above and break the vendor that works today.
 *
 * 🛑 IT ASSERTED NOTHING FOR ITS ENTIRE GREEN LIFE, and the spawn seam is what
 * fixes that. It was `assert.rejects` whose predicate ran
 * `doesNotMatch(/CURSOR_API_KEY on file/)` and then `return true`, so EVERY
 * error satisfied it. Being green only ever meant "something threw", and the
 * something was a missing Cursor image. Once that image existed the start
 * SUCCEEDED, no rejection came, and the spec went red — on a commit that had
 * changed neither the check nor the test.
 *
 * 🛑 AND IT WAS STARTING A REAL CONTAINER INSIDE `npm test`. The passing path
 * took 5.9 seconds of `docker run`, which is why a contended daemon could flip
 * it either way. A fake child leaves the credential check as the only thing
 * under test, and the unit lane no longer needs a daemon.
 */
test("a confirmed Cursor handle with its own key gets past the credential check", async () => {
  const db = new DatabaseSync(":memory:");
  migrate(db);

  const handle = `pvg-${process.pid}-confirmed`;
  const seen: SpawnOptions[] = [];

  setVendorToken(claudeSpawn, "sk-ant-oat-x");
  setVendorToken(cursorSpawn, "key_cursor-x");
  confirmHandle(handle, cursorSpawn);

  const sup = await startSupervisor(
    supervisorOptions({
      handle,
      db,
      vendor: cursorSpawn,
      extraDirs: [process.cwd()],
      driver: "docker-cursor",
      reply: false,
      spawnChild: recordingChild(seen),
      log: () => undefined,
    }),
  );

  try {
    // Reaching the spawn IS the claim: the credential check sits in front of
    // it, so one recorded spawn means the Cursor key satisfied that check.
    assert.equal(seen.length, 1);
  } finally {
    await sup.stop();
  }
});
