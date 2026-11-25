import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { ChildGrant } from "../../../src/supervise/grant.js";
import type { VendorSpawn } from "../../../src/supervise/vendor.js";

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
 *
 * 🛑 THE REFUSAL IS NOW PER VENDOR, AND NEITHER SHIPPED VENDOR TAKES IT. #449:
 * a user who cannot mint a long-lived token could not start ANY supervised
 * agent, while the CLI they already log into with a browser authenticates
 * itself. `hostAuth` is the declaration, and the fixture below is the only
 * actor left that refuses — which is why it exists rather than being a tidier
 * way to say the same thing.
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
/**
 * 🛑 `configPath` POINTS INSIDE THE GIVEN CWD, NOT AT A FIXED `/tmp` NAME. A
 * mutant that made the writer land `grant.configPath` left a real file at a
 * shared path, and the NEXT run then failed on it — a passing suite that
 * depended on run order.
 */
function grantIn(cwd: string): ChildGrant {
  return {
    handle: "h-child",
    configPath: join(cwd, "state-dir-path-cursor-never-reads.json"),
    allowed: [],
    available: [],
    extraDirs: [],
  };
}

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

test("🛑 a host child is handed its own credential, and only a token-required vendor refuses without one", async (t: TestContext) => {
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

  /**
   * 🛑 THE ONLY REMAINING ACTOR FOR THE REFUSAL, AND IT IS A FIXTURE BECAUSE
   * BOTH SHIPPED VENDORS NOW SELF-AUTHENTICATE. A guard whose every live
   * caller opted out is a guard no test reaches, and #396 is what happens when
   * nothing reaches it.
   *
   * ⚠️ BUILT FROM `cursorSpawn`, SO IT CARRIES A `"file"` GRANT DELIVERY. The
   * ordering this pins — refuse before the grant writer — is unreachable by a
   * vendor whose grant costs no filesystem write, which is the hole the
   * original ungranted-only version of this test had.
   *
   * ⚠️ ITS OWN `authEnvVar`, so a token stored for Cursor below cannot satisfy
   * it. A shared name would make this arm pass for the wrong reason.
   */
  const tokenOnly = {
    ...cursorSpawn,
    vendor: "tokenonly",
    authEnvVar: "TOKENONLY_API_KEY",
    authSetupHint: "this vendor is fictional and has no login",
    hostAuth: "token-required",
  } as VendorSpawn;

  // 🛑 THE REFUSAL FIRST, WHILE THE STORE IS STILL EMPTY. lee ruled at `#mcp`
  // 16657 that an unauthenticated child must refuse to START, rather than
  // start, take the prompt and exit 1 — the prompt is lost either way, and
  // only the refusal names the cause.
  //
  // 🛑 WITH A GRANT, BECAUSE AN UNGRANTED CHILD CANNOT REACH THE ORDERING THIS
  // PINS. Measured: moving the token check BELOW the grant block left an
  // ungranted-only version of this test GREEN, since the block it has to beat
  // never ran. The actor that reaches it is a FILE-delivered vendor carrying a
  // grant and no credential.
  const refused = mkdtempSync(join(tmpdir(), "chat-mcp-cred-refused-"));

  assert.throws(
    () =>
      spawnOnHost(tokenOnly, {
        cwd: refused,
        grant: grantIn(refused),
      }),
    /no TOKENONLY_API_KEY on file/,
    "a token-required child with no token on file was allowed to start",
  );

  // 🛑 AND IT LEFT NOTHING BEHIND. A refusal that came after the writer would
  // plant `.cursor/mcp.json` in the operator's own project directory for a
  // child that never ran — litter #348 already refuses to create for an
  // ungranted child.
  assert.ok(
    !existsSync(join(refused, ".cursor")),
    "a refused child left a grant config in the operator's project directory",
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

  /**
   * 🛑 #449, AND IT IS THE WHOLE POINT OF THE TICKET. `claude setup-token`
   * needs a subscription, so a user without one had no way to produce the
   * value the refusal demanded — and the feature did not exist for them.
   * Measured on the ticket against `claude` 2.1.278 with a browser login and
   * no token anywhere in the environment: `claude -p --input-format
   * stream-json` exits 0 and replies.
   *
   * ⚠️ THE PRECONDITION IS ASSERTED, NOT ASSUMED. A runner whose own
   * environment carries the var would make the absence assertion below
   * measure the runner rather than this code.
   */
  assert.equal(
    process.env[claudeSpawn.authEnvVar],
    undefined,
    "the test runner's own environment carries the credential under test",
  );

  spawnOnHost(claudeSpawn, { cwd: process.env.CHAT_MCP_HOME });

  assert.equal(
    spawns.length,
    1,
    "a self-authenticating claude child with no token on file did not start",
  );

  /**
   * 🛑 THE KEY IS ABSENT, NOT EMPTY, AND THE DIFFERENCE IS MEASURED. From the
   * ticket, against a working browser login:
   *
   *   bogus CLAUDE_CODE_OAUTH_TOKEN -> exit 1, "401 OAuth access token is
   *   invalid"
   *
   * So the env var OVERRIDES the login rather than filling a gap, which is
   * #347's finding for `CURSOR_API_KEY` confirmed for Claude Code. Whether an
   * EMPTY string is ignored or overrides was never run, so this forbids the
   * key outright.
   *
   * ⚠️ `hasOwn`, NOT `=== undefined`. `{ [k]: undefined }` reads as undefined
   * and still puts the key in the object, and that is exactly the shape a
   * one-character fix would produce.
   */
  assert.equal(
    Object.hasOwn(spawns[0]?.env ?? {}, claudeSpawn.authEnvVar),
    false,
    "an absent credential was injected as an empty or undefined value",
  );

  /**
   * 🛑 THE FALLBACK lee ASKED FOR, AND IT IS NOT IMPLIED BY THE ARM ABOVE. A
   * fix that simply stopped injecting on the host would pass everything so far
   * and silently strand every operator who DOES have a token on file.
   */
  setVendorToken(claudeSpawn, "claude-token-for-the-child");

  spawnOnHost(claudeSpawn, { cwd: process.env.CHAT_MCP_HOME });

  assert.equal(
    spawns.length,
    2,
    "the authenticated claude child did not spawn",
  );
  assert.equal(
    spawns[1]?.env?.[claudeSpawn.authEnvVar],
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

  const granted = mkdtempSync(join(tmpdir(), "chat-mcp-cred-granted-"));

  spawnOnHost(cursorSpawn, { cwd: granted, grant: grantIn(granted) });

  /**
   * ⚠️ NO SPAWN TO ASSERT HERE, AND THAT IS CURSOR'S CONTRACT RATHER THAN A
   * GAP. `processPerTurn` is true, so `spawnOnHost` returns a lazy launcher
   * and the first `docker`-free process only starts on a turn. The injection
   * is pinned on the claude arm above, which is `processPerTurn: false`.
   */
  assert.equal(
    spawns.length,
    2,
    "a per-turn vendor spawned a process at wiring time",
  );

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
