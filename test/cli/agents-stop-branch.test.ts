import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * 🛑 THE CLI'S OWN BRANCH, WHICH NOTHING COVERED.
 *
 * `agents stop` prints one of two sentences depending on WHY the control
 * failed. Both PR 296 and PR 298 changed how that choice is made, and
 * inverting the ternary failed no test either time — claude1 said so on both.
 *
 * So this drives the real command as a child process. The parent binds the
 * socket, which is why both sides need the same `CHAT_MCP_HOME`.
 */

const HOME = mkdtempSync(join(tmpdir(), "chat-mcp-cli-stop-"));
process.env.CHAT_MCP_HOME = HOME;

const { WakeListener } = await import("../../src/supervise/socket.js");

const ENTRY = resolve(import.meta.dirname, "..", "..", "src", "index.ts");

interface Run {
  readonly code: number | null;
  readonly stderr: string;
  readonly stdout: string;
}

/** Run `chat-mcp agents <action> <handle>` for real and collect its output. */
function runCli(args: readonly string[]): Promise<Run> {
  return new Promise((done) => {
    const child = spawn(process.execPath, ["--import", "tsx", ENTRY, ...args], {
      env: { ...process.env, CHAT_MCP_HOME: HOME },
    });
    let stderr = "";
    let stdout = "";

    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
    child.on("close", (code) => done({ code, stderr, stdout }));
  });
}

test("with nothing listening it names the HANDLE and says nothing is listening", async () => {
  const r = await runCli(["agents", "stop", "ghost"]);

  assert.match(r.stderr, /no supervisor is listening for "ghost"/);
  // 🛑 The other branch's wording must be ABSENT, not merely unmentioned.
  // Inverting the ternary prints "refused" here, and a match-only assertion
  // on the first sentence would still pass.
  assert.doesNotMatch(r.stderr, /refused/);
  assert.equal(r.code, 1);
});

test("a REFUSED stop prints the supervisor's own reason, not the unreachable line", async () => {
  const l = await WakeListener.bind("picky", () => ({
    ok: false,
    error: "mid-turn, try --now",
  }));

  try {
    const r = await runCli(["agents", "stop", "picky"]);

    assert.match(r.stderr, /stop refused for picky: mid-turn, try --now/);
    assert.doesNotMatch(r.stderr, /no supervisor is listening/);
    assert.equal(r.code, 1);
  } finally {
    await l.close();
  }
});
