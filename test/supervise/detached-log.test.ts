import { test } from "node:test";
import assert from "node:assert/strict";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 🛑 BEFORE any import that resolves a state path.
process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), "cm-detlog-"));

const { openSupervisorLog } = await import("../../src/supervise/detached.js");
const { logDir, logPathFor } = await import("../../src/util/paths.js");

/**
 * The file a detached supervisor's stdout and stderr are pointed at — #423.
 *
 * 🛑 TESTED APART FROM THE SPAWN ON PURPOSE. A real
 * `startDetachedSupervisor` reparents to init and outlives the test that
 * called it, so the half worth asserting is the one that opens this file.
 */

test("the opened file is the one `logPathFor` names, and the dir is made", () => {
  rmSync(logDir(), { recursive: true, force: true });

  const { path, fd } = openSupervisorLog("h1");
  closeSync(fd);

  assert.equal(path, logPathFor("h1"));
  assert.ok(existsSync(path), "the log file was not created");
});

/**
 * 🛑 THE FIRST LINES CARRY THE CHILD'S ALLOWED-TOOL LIST AND ITS SOCKET PATH,
 * which is why another local account must not be able to read it.
 */
test("🛑 the log is owner-only, and that is not left to the umask", () => {
  const { path, fd } = openSupervisorLog("h2");
  closeSync(fd);

  assert.equal(statSync(path).mode & 0o777, 0o600);
});

/**
 * ⚠️ APPEND, NOT TRUNCATE. A restart that truncated would destroy the log of
 * the run an operator is restarting BECAUSE of.
 */
test("⚠️ a second open APPENDS, so a restart keeps the run before it", () => {
  const first = openSupervisorLog("h3");
  writeSync(first.fd, "run one\n");
  closeSync(first.fd);

  const second = openSupervisorLog("h3");
  writeSync(second.fd, "run two\n");
  closeSync(second.fd);

  assert.equal(readFileSync(first.path, "utf8"), "run one\nrun two\n");
});

/** 🛑 The handle becomes a filename, so the existing rule is reused. */
test("🛑 a traversing handle is refused rather than opening a file outside", () => {
  assert.throws(() => openSupervisorLog("../escape"), /Invalid handle/);
});
