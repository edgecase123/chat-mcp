import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CHAT_MCP_HOME = mkdtempSync(
  join(tmpdir(), "chat-mcp-per-vendor-auth-"),
);

const { CLAUDE_TOKEN_KEY, readVendorToken, setVendorToken } =
  await import("../../src/supervise/auth.js");
const { claudeSpawn } = await import("../../src/adapters/claude-spawn.js");
const { cursorSpawn } = await import("../../src/adapters/cursor-spawn.js");
const { dockerRunPlan } =
  await import("../../src/supervise/drivers/containerized.js");

const PROJECT_DIR = mkdtempSync(join(tmpdir(), "chat-mcp-per-vendor-project-"));

/**
 * 🛑 TWO SENTINELS THAT CANNOT BE CONFUSED, because the defect this file pins
 * is one credential reaching both vendors. A shared value would satisfy every
 * assertion below while the bug stood — a value comparison cannot catch a
 * copy.
 */
const CLAUDE_SENTINEL = "sk-ant-oat-CLAUDE-ONLY";
const CURSOR_SENTINEL = "key_CURSOR-ONLY";

function planFor(vendor: typeof claudeSpawn) {
  return dockerRunPlan(vendor, {
    cwd: PROJECT_DIR,
    supervisorHandle: "claude1",
  });
}

/**
 * 🛑 THE STORAGE KEY AND THE INJECTED ENV VAR NAME ARE ONE STRING. `GH_TOKEN`
 * already carries this rule in `auth.ts`; the Claude token had the same
 * property by coincidence and nothing noticed it. Two literals would let a
 * rename store under one name and inject the other, and the container would
 * get an UNSET credential — which reads as a bad one, not as none.
 */
test("🛑 the Claude storage key IS the vendor's injected env var name", () => {
  assert.equal(CLAUDE_TOKEN_KEY, claudeSpawn.authEnvVar);
});

test("🔴 a Cursor container is NOT handed the Claude token", () => {
  setVendorToken(claudeSpawn, CLAUDE_SENTINEL);

  // The whole of #347: one `readToken()` fed every vendor's `authEnvVar`, so
  // `cursor-agent` received a Claude subscription credential and sent it to
  // Cursor's servers as its own.
  assert.throws(() => planFor(cursorSpawn), /CURSOR_API_KEY/);
});

/**
 * 🛑 THE COMMAND MUST BE RUNNABLE, NOT A TEMPLATE. This asserted `/cursor/i`
 * and greened on the word "Cursor" inside `authSetupHint`, so it would not
 * have noticed the refusal printing a literal `--vendor <name>` placeholder.
 * Raised by claude1 on PR 354.
 */
test("the refusal prints a command the operator can run unchanged", () => {
  setVendorToken(claudeSpawn, CLAUDE_SENTINEL);

  assert.throws(() => planFor(cursorSpawn), /auth set-token --vendor cursor/);
  assert.throws(() => planFor(cursorSpawn), /CURSOR_API_KEY/);
  // The control: the placeholder the message used to carry must be gone.
  assert.throws(
    () => planFor(cursorSpawn),
    (err: Error) => {
      assert.doesNotMatch(err.message, /--vendor <name>/);
      return true;
    },
  );
});

test("a stored Cursor key reaches the Cursor container, and nothing else does", () => {
  setVendorToken(claudeSpawn, CLAUDE_SENTINEL);
  setVendorToken(cursorSpawn, CURSOR_SENTINEL);

  const { env } = planFor(cursorSpawn);

  assert.equal(env.CURSOR_API_KEY, CURSOR_SENTINEL);
  // The control that catches a copy: the Claude value must be absent from the
  // Cursor container's credential, not merely different from some other field.
  assert.notEqual(env.CURSOR_API_KEY, CLAUDE_SENTINEL);
});

/**
 * The paired control. A fix that simply stopped injecting anything would pass
 * every assertion above and break the vendor that works today.
 */
test("a Claude container still gets the Claude token, unchanged", () => {
  setVendorToken(claudeSpawn, CLAUDE_SENTINEL);
  setVendorToken(cursorSpawn, CURSOR_SENTINEL);

  const { env } = planFor(claudeSpawn);

  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, CLAUDE_SENTINEL);
  assert.notEqual(env.CLAUDE_CODE_OAUTH_TOKEN, CURSOR_SENTINEL);
});

test("each vendor reads its own credential and cannot see the other's", () => {
  setVendorToken(claudeSpawn, CLAUDE_SENTINEL);
  setVendorToken(cursorSpawn, CURSOR_SENTINEL);

  assert.equal(readVendorToken(claudeSpawn), CLAUDE_SENTINEL);
  assert.equal(readVendorToken(cursorSpawn), CURSOR_SENTINEL);
});

/**
 * 🛑 A SECOND CREDENTIAL MUST NOT DISPLACE THE FIRST. Both live in one
 * `secrets.env`, and a writer that rebuilds the file whole drops the other —
 * a failure whose symptom arrives much later than its cause.
 */
test("storing a Cursor key leaves the Claude token on file", () => {
  setVendorToken(claudeSpawn, CLAUDE_SENTINEL);
  setVendorToken(cursorSpawn, CURSOR_SENTINEL);

  assert.equal(readVendorToken(claudeSpawn), CLAUDE_SENTINEL);
});

/**
 * 🛑 THE OPERATOR'S ACTUAL COMMAND, RUN AS A SUBPROCESS. `src/index.ts` runs
 * the CLI on import, so no in-process test can reach this path — and a
 * source-text pin would pass against a docblock mentioning the flag while the
 * live code ignored it.
 */
test("🛑 `auth set-token --vendor cursor` stores under CURSOR_API_KEY", () => {
  const home = mkdtempSync(join(tmpdir(), "chat-mcp-auth-cli-"));

  const run = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "src/index.ts",
      "auth",
      "set-token",
      "--vendor",
      "cursor",
    ],
    {
      cwd: new URL("../..", import.meta.url).pathname,
      env: {
        ...process.env,
        CHAT_MCP_HOME: home,
        NODE_TEST_CONTEXT: undefined,
      },
      input: "key_FROM-THE-CLI",
      encoding: "utf8",
    },
  );

  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);

  const stored = readFileSync(join(home, "secrets.env"), "utf8");

  assert.match(stored, /^CURSOR_API_KEY=key_FROM-THE-CLI$/m);
  // The control: the key must not also land under the Claude name, which is
  // where every token went before #347.
  assert.doesNotMatch(stored, /CLAUDE_CODE_OAUTH_TOKEN/);
});

/**
 * The paired control. A default that silently resolved to cursor, or to
 * nothing, would pass the test above.
 */
test("`auth set-token` with no --vendor still stores the Claude token", () => {
  const home = mkdtempSync(join(tmpdir(), "chat-mcp-auth-cli-default-"));

  const run = spawnSync(
    process.execPath,
    ["--import", "tsx", "src/index.ts", "auth", "set-token"],
    {
      cwd: new URL("../..", import.meta.url).pathname,
      env: {
        ...process.env,
        CHAT_MCP_HOME: home,
        NODE_TEST_CONTEXT: undefined,
      },
      input: "sk-ant-oat-FROM-THE-CLI",
      encoding: "utf8",
    },
  );

  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);

  const stored = readFileSync(join(home, "secrets.env"), "utf8");

  assert.match(stored, /^CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat-FROM-THE-CLI$/m);
  assert.doesNotMatch(stored, /CURSOR_API_KEY/);
});

test("🔴 an unknown --vendor is refused, naming the vendors that exist", () => {
  const home = mkdtempSync(join(tmpdir(), "chat-mcp-auth-cli-bad-"));

  const run = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "src/index.ts",
      "auth",
      "set-token",
      "--vendor",
      "codex",
    ],
    {
      cwd: new URL("../..", import.meta.url).pathname,
      env: {
        ...process.env,
        CHAT_MCP_HOME: home,
        NODE_TEST_CONTEXT: undefined,
      },
      input: "key_SHOULD-NOT-BE-STORED",
      encoding: "utf8",
    },
  );

  assert.notEqual(run.status, 0);
  assert.match(`${run.stdout}${run.stderr}`, /codex/);
  assert.match(`${run.stdout}${run.stderr}`, /cursor/);
  // 🛑 REFUSED BEFORE THE SECRET IS READ, so nothing was written at all.
  assert.equal(existsSync(join(home, "secrets.env")), false);
});
