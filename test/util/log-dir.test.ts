import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 🛑 BEFORE any import that resolves a state path.
process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), "chat-mcp-log-dir-"));

const { STATE_DIR_MODE, ensureLogDir, logDir, logPathFor, stateDir } =
  await import("../../src/util/paths.js");
const { realContains } = await import("../../src/supervise/containment.js");

/**
 * 🛑 A CHILD OF THE STATE DIR, AND THE REASON IS NOT "IT LOOKS TIDY".
 *
 * lee's answer on #423 was `~/.chat-mcp/logs/<handle>.log`, and `stateDir()`
 * resolves to `~/.chat-mcp` in normal use — so this is his path, routed through
 * the one function that refuses the default under the test runner.
 *
 * ⚠️ A SIBLING WOULD OWE AN `assertDisjoint` BRANCH. `manifestDir()` is a
 * sibling precisely because it needs one; a child is covered by
 * `assertProjectDirOutsideState`'s existing `stateDir()` branch.
 */
test("🛑 the log dir is a CHILD of the state dir, so the existing project-dir guard covers it", () => {
  assert.equal(logDir(), join(stateDir(), "logs"));
  assert.equal(realContains(stateDir(), ensureLogDir()), true);
});

/**
 * ⚠️ IT MUST FOLLOW `CHAT_MCP_HOME`, or a test writes into the operator's real
 * tree. A path built from `homedir()` would bypass `stateDir()`'s refusal.
 */
test("🛑 it follows CHAT_MCP_HOME, so a test cannot reach the real one", () => {
  assert.ok(
    logDir().startsWith(process.env.CHAT_MCP_HOME as string),
    `${logDir()} does not follow CHAT_MCP_HOME`,
  );
  assert.ok(
    logPathFor("claude2").startsWith(process.env.CHAT_MCP_HOME as string),
    `${logPathFor("claude2")} does not follow CHAT_MCP_HOME`,
  );
});

test("a handle's log is inside the log dir, and named for the handle", () => {
  assert.equal(logPathFor("claude2"), join(logDir(), "claude2.log"));
});

/**
 * 🛑 THE HANDLE BECOMES A FILENAME, SO IT IS VALIDATED.
 *
 * A detached start points the child's stdio at this path, so a traversing
 * handle would truncate a file of the attacker's choosing with the supervisor's
 * own privileges. `assertHandle` is reused rather than a second rule written.
 */
test("🛑 a traversing handle is refused rather than naming a file outside the log dir", () => {
  assert.throws(() => logPathFor("../claude1"), /Invalid handle/);
  assert.throws(() => logPathFor("a/b"), /Invalid handle/);
  assert.throws(() => logPathFor(""), /Invalid handle/);
});

/**
 * 🛑 0700, BECAUSE A SUPERVISOR LOG CARRIES THE CHILD'S OWN OUTPUT.
 *
 * Step 0 on #423 captured the allowed-tool list and the socket path in the
 * first four lines. The directory mode is what keeps another local account out,
 * for the same reason `ensureSocketDir` chmods rather than trusting the umask.
 */
test("🛑 the log dir is 0700, and the chmod is not left to the umask", () => {
  const dir = ensureLogDir();

  assert.equal(statSync(dir).mode & 0o777, STATE_DIR_MODE);
});
