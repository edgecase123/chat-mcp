/**
 * 🛑 THE HOST RAN A FILE THE SANDBOXED AGENT COULD REWRITE. The project
 * directory is bind-mounted WRITABLE, because it is the agent's own clone and
 * it has to be. `runScript` then reaches that same directory with `execFile`,
 * on the host, as the operator — so the agent chose the bytes the operator ran.
 *
 * lee, 2026-11-15, ruling: *"anything the agent can write is NOT trusted to
 * run outside of the container."*
 *
 * ⚠️ `readOnlyPaths` CANNOT satisfy that, at any depth. A `:ro` bind holds only
 * while every directory between it and the project root is itself a mountpoint,
 * and only the root is. Measured on four shapes: a direct child holds, anything
 * nested is defeated by renaming an ancestor and symlinking its name back.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 🛑 BEFORE any import that resolves a state path.
process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), "chat-mcp-ccr-"));

const { Refusal, runCommandFor } =
  await import("../../src/supervise/run-command-service.js");
const { registerProject } = await import("../../src/supervise/projects.js");
const { ensureManifestDir, manifestPathFor } =
  await import("../../src/util/paths.js");

/**
 * ⚠️ ONE MARKER PER TEST, NOT ONE SHARED. A shared path makes the refusal test
 * depend on running BEFORE the control that creates it, and a file's test order
 * is not a contract worth leaning on.
 */
function markerFor(handle: string): string {
  return join(process.env.CHAT_MCP_HOME as string, `ran-${handle}`);
}

function project(marker: string): { dir: string; manifest: unknown } {
  const dir = mkdtempSync(join(tmpdir(), "chat-mcp-ccr-project-"));

  mkdirSync(join(dir, "scripts"), { recursive: true });

  const path = join(dir, "scripts", "gate.sh");
  writeFileSync(path, `#!/bin/sh\ntouch ${marker}\necho ran\n`);
  chmodSync(path, 0o755);

  return {
    dir,
    manifest: {
      projectDir: dir,
      commands: [{ name: "run-gate", script: "scripts/gate.sh" }],
    },
  };
}

function install(handle: string): void {
  const built = project(markerFor(handle));

  ensureManifestDir();
  writeFileSync(manifestPathFor(handle), JSON.stringify(built.manifest));
  registerProject(handle, built.dir);
}

test("🚨 a containerized agent's command is refused, and the script does not run", async () => {
  install("ccr-docker");

  await assert.rejects(
    () => runCommandFor("ccr-docker", "run-gate", {}, { sandbox: "docker" }),
    (err: unknown) => {
      assert.ok(err instanceof Refusal, "must be a Refusal");
      assert.match(err.message, /container/i);
      return true;
    },
  );

  // ⚠️ THE MARKER IS THE ASSERTION, NOT THE THROW. A refusal raised AFTER
  // `execFile` would still reject, and the host would still have run the
  // agent's bytes.
  assert.equal(
    existsSync(markerFor("ccr-docker")),
    false,
    "the script ran before the refusal, so the refusal is cosmetic",
  );
});

test("a host agent's command still runs — the control for the refusal above", async () => {
  install("ccr-host");

  const result = await runCommandFor(
    "ccr-host",
    "run-gate",
    {},
    { sandbox: "host" },
  );

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.trim(), "ran");
  assert.equal(
    existsSync(markerFor("ccr-host")),
    true,
    "the control did not run either, so the test above proves nothing",
  );
});
