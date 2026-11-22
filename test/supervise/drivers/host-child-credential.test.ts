import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

// 🛑 BEFORE any import that resolves a state path, per AGENTS.md. The token is
// read from the secrets file under the state dir, which the node runner
// refuses when it is the operator's live `~/.chat-mcp`. Every import below is
// therefore dynamic.
process.env.CHAT_MCP_HOME = mkdtempSync(
  join(tmpdir(), "chat-mcp-host-cred-home-"),
);

/**
 * 🛑 A HOST CHILD WAS NEVER GIVEN ITS API KEY, SO EVERY TURN WAS LOST AND THE
 * START LOOKED CLEAN.
 *
 * Measured in the live paid host run lee authorised at `#mcp` 16613:
 *
 *   ← child stderr: Error: Authentication required. Please run 'agent login'
 *                   first, or set CURSOR_API_KEY environment variable.
 *     child exited code=1 signal=null; 0 prompt(s) never sent
 *
 * The supervisor reported the child as started, the prompt as delivered and
 * the socket as ACKed. `spawnOnHost` passed `cwd` and `stdio` and no `env`, so
 * the child inherited a `process.env` the token has never been in — it lives
 * in the secrets file. The CONTAINER path already injects it.
 *
 * 🛑 THE ACCEPTANCE SCRIPT'S "a real CURSOR_API_KEY is on file" PASSED
 * THROUGHOUT. On file is not in the child's environment, which is why this
 * asserts the `env` `spawn` RECEIVES rather than the store's contents.
 */

/**
 * 🛑 ONE TEST FOR EVERY CASE, ON PURPOSE. The module mock reverts with the test
 * context, and a second test would meet an already-imported `host.js` — so the
 * refusal, the injection and the approval's own environment are asserted
 * against one recording.
 *
 * ⚠️ THE VENDORS ARE IMPORTED INSIDE THE TEST. `cursor-spawn.ts` pulls in
 * `host-grant.js`, which binds `execFileSync` at module load, so a top-level
 * import defeats `t.mock.module` before it runs. PR 394 lost a CI run to
 * exactly that.
 */
function fakeChild(): ChildProcessWithoutNullStreams {
  const stream = () => {
    const s = new EventEmitter() as EventEmitter & {
      setEncoding: (e: string) => void;
    };
    s.setEncoding = () => undefined;

    return s;
  };

  return {
    stdout: stream(),
    stderr: stream(),
    stdin: { write: () => true, end: () => undefined },
    on: () => undefined,
    kill: () => undefined,
  } as unknown as ChildProcessWithoutNullStreams;
}

test("🛑 the host child is handed its own credential, and no child starts without one", async (t: TestContext) => {
  const spawns: { env?: NodeJS.ProcessEnv }[] = [];
  const approvals: { env?: NodeJS.ProcessEnv }[] = [];

  t.mock.module("node:child_process", {
    namedExports: {
      spawn: (
        _command: string,
        _args: string[],
        opts: { env?: NodeJS.ProcessEnv },
      ) => {
        spawns.push({ env: opts?.env });

        return fakeChild();
      },
      execFileSync: (
        _command: string,
        _args: string[],
        opts: { env?: NodeJS.ProcessEnv },
      ) => {
        approvals.push({ env: opts?.env });

        return "";
      },
    },
  });

  const { spawnOnHost } =
    await import("../../../src/supervise/drivers/host.js");
  const { cursorSpawn } = await import("../../../src/adapters/cursor-spawn.js");
  const { claudeSpawn } = await import("../../../src/adapters/claude-spawn.js");
  const { setVendorToken } = await import("../../../src/supervise/auth.js");

  // 🛑 THE REFUSAL FIRST, WHILE THE STORE IS STILL EMPTY. lee ruled at `#mcp`
  // 16657 that an unauthenticated child must refuse to START, rather than
  // start, take the prompt and exit 1 — the prompt is lost either way, and
  // only the refusal names the cause.
  assert.throws(
    () => spawnOnHost(cursorSpawn, { cwd: process.env.CHAT_MCP_HOME }),
    /no CURSOR_API_KEY on file/,
    "a cursor child with no token on file was allowed to start",
  );

  // 🛑 NOT CURSOR-SPECIFIC. The defect was found on cursor, but the missing
  // `env` was in `spawnOnHost`, so a fix scoped to one vendor would leave the
  // other on the same silence.
  assert.throws(
    () => spawnOnHost(claudeSpawn, { cwd: process.env.CHAT_MCP_HOME }),
    /no CLAUDE_CODE_OAUTH_TOKEN on file/,
    "a claude child with no token on file was allowed to start",
  );

  // 🛑 NOTHING SPAWNED AND NOTHING WAS APPROVED. A refusal that happens AFTER
  // the grant file is written leaves `.cursor/mcp.json` in the operator's
  // project for a child that never ran.
  // ⚠️ LENGTH, NOT `deepEqual(spawns, [])`. `assert/strict`'s `deepEqual`
  // carries an `asserts actual is T` signature, so comparing against `[]`
  // narrows these arrays to `never[]` and every later `spawns[0]?.env` becomes
  // a TS2339. Only `npm run typecheck` sees it; the runtime assertions pass.
  assert.equal(spawns.length, 0, "a child was spawned before the token check");
  assert.equal(
    approvals.length,
    0,
    "a server was approved for a child that was refused",
  );

  setVendorToken(claudeSpawn, "claude-token-for-the-child");

  spawnOnHost(claudeSpawn, { cwd: process.env.CHAT_MCP_HOME });

  assert.equal(
    spawns.length,
    1,
    "the authenticated claude child did not spawn",
  );
  assert.equal(
    spawns[0]?.env?.[claudeSpawn.authEnvVar],
    "claude-token-for-the-child",
    "the child's env did not carry its vendor's credential",
  );

  // 🛑 THE CHILD'S ENVIRONMENT, NOT THE SUPERVISOR'S. Writing the token into
  // `process.env` would reach every later child of every vendor, which is the
  // cross-vendor leak #347 was filed for.
  assert.equal(
    process.env[claudeSpawn.authEnvVar],
    undefined,
    "the token was written into the supervisor's own environment",
  );

  setVendorToken(cursorSpawn, "cursor-token-for-the-child");

  spawnOnHost(cursorSpawn, {
    cwd: process.env.CHAT_MCP_HOME,
    grant: {
      handle: "h-child",
      configPath: join(process.env.CHAT_MCP_HOME!, "never-read.json"),
      allowed: [],
      available: [],
      extraDirs: [],
    },
  });

  // 🛑 THE APPROVAL EXEC IS DECIDED, NOT OVERLOOKED. lee's 16654 permits the
  // token in a child's `env`; `cursor-agent mcp enable` needs no credential,
  // measured, so this one is handed none. Without this assertion a later
  // change that spread the child's env here would widen the exposure silently.
  assert.equal(
    approvals.length,
    1,
    "the granted cursor child was not approved",
  );
  assert.equal(
    approvals[0]?.env?.[cursorSpawn.authEnvVar],
    undefined,
    "the approval exec was handed a credential it does not need",
  );
});
