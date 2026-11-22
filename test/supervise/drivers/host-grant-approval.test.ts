import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { ChildGrant } from "../../../src/supervise/grant.js";

// 🛑 BEFORE any import that resolves a state path, per AGENTS.md. The approval
// path reads the vendor's token to REDACT it from a failure message, and
// `auth.ts` resolves the state dir — which the node runner refuses when it is
// the operator's live `~/.chat-mcp`. Every import below is therefore dynamic.
process.env.CHAT_MCP_HOME = mkdtempSync(
  join(tmpdir(), "chat-mcp-approve-home-"),
);

/**
 * 🛑 WRITING THE CONFIG IS NOT WIRING THE BUS, AND #348 SHIPPED BELIEVING IT
 * WAS.
 *
 * Measured against the live `cursor-agent` 2026.11.19 in an empty temp cwd
 * holding only the config this project writes:
 *
 *   cursor-agent mcp list          -> chat: not loaded (needs approval)
 *   cursor-agent mcp list-tools    -> MCP server "chat" has not been approved
 *   cursor-agent mcp enable chat   -> chat: ready, 24 tools
 *
 * So a granted HOST Cursor child started with ZERO bus tools. That is the
 * silence #348 exists to end, reproduced with the fix for it in place.
 *
 * ⚠️ IT EXECUTES NO CLI. `node:child_process` is mocked, the same instrument
 * `host-grant-delivered-on-spawn.test.ts` uses — and the reason that file
 * exists is the reason this one does: a correct step nothing calls is
 * indistinguishable from no step at all.
 */

/**
 * 🛑 THE VENDORS ARE IMPORTED INSIDE THE TEST, AND A STATIC IMPORT SILENTLY
 * DEFEATS THE MOCK.
 *
 * `cursor-spawn.ts` imports `host-grant.js` for `cursorProjectMcpConfigPath`,
 * so naming `cursorSpawn` at the top of this file loads the module under test
 * with the REAL `execFileSync` bound — before `t.mock.module` runs. The first
 * cut did exactly that, recorded zero executions, and read as "the approval
 * step was never added" while the step was there and working.
 *
 * ⚠️ IT DOES NOT LOOK LIKE AN INSTRUMENT FAULT. The failure message is the one
 * this test writes for a missing call, so it accuses the code.
 */
async function vendors() {
  const { cursorSpawn } = await import("../../../src/adapters/cursor-spawn.js");
  const { claudeSpawn } = await import("../../../src/adapters/claude-spawn.js");

  return { cursorSpawn, claudeSpawn };
}

/**
 * 🛑 `configPath` POINTS INSIDE THE TEMP CWD, NOT AT A FIXED `/tmp` NAME. A
 * mutant that made the writer land `grant.configPath` left a real file at a
 * shared path, and the NEXT run then failed on it — so a passing suite
 * depended on run order and the failure read as a code defect.
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

interface Execution {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string | undefined;
}

/**
 * 🛑 ONE TEST, ONE MOCK, EVERY CASE — AND THAT IS A CONSTRAINT, NOT A STYLE
 * CHOICE. `t.mock.module` reverts with the test context, so a SECOND test
 * meets an already-imported `host.js` still bound to the FIRST test's fake.
 * Measured: the refusal case written as its own test recorded the passing
 * fake and failed with "Missing expected exception", accusing the code of a
 * missing throw that was present. The refusal is therefore driven by flipping
 * `refuse` inside this one recording.
 */
test("🛑 spawnOnHost APPROVES cursor's bus server, so a granted host child has tools", async (t: TestContext) => {
  const runs: Execution[] = [];
  let refuse = false;

  t.mock.module("node:child_process", {
    namedExports: {
      spawn: () => fakeChild(),

      execFileSync: (
        command: string,
        args: readonly string[],
        opts: { cwd?: string },
      ) => {
        runs.push({ command, args, cwd: opts?.cwd });

        if (refuse) {
          throw Object.assign(new Error("Command failed"), {
            status: 1,

            // 🛑 THE CREDENTIAL IS IN THE STDERR ON PURPOSE. A CLI whose auth
            // diagnostics echo a key is the case the redaction exists for, and
            // a stderr without one cannot tell a working redaction from an
            // absent secret.
            stderr: `unknown MCP server 'chat' (auth ${SECRET})`,
          });
        }

        return "";
      },
    },
  });

  const { spawnOnHost } =
    await import("../../../src/supervise/drivers/host.js");
  const { cursorSpawn, claudeSpawn } = await vendors();
  const { setVendorToken } = await import("../../../src/supervise/auth.js");

  // 🛑 A REAL-SHAPED CREDENTIAL ON FILE, SO THE REFUSAL BELOW HAS ONE TO LEAK.
  // Without this the redaction assertion passes for the wrong reason: there is
  // simply nothing to find. `CHAT_MCP_HOME` is a temp dir, set at the top.
  const SECRET = "key_live_0123456789abcdefSECRET";
  setVendorToken(cursorSpawn, SECRET);

  const granted = mkdtempSync(join(tmpdir(), "chat-mcp-approve-granted-"));
  const ungranted = mkdtempSync(join(tmpdir(), "chat-mcp-approve-ungranted-"));
  const claude = mkdtempSync(join(tmpdir(), "chat-mcp-approve-claude-"));
  const refused = mkdtempSync(join(tmpdir(), "chat-mcp-approve-refused-"));

  try {
    spawnOnHost(cursorSpawn, { grant: grantIn(granted), cwd: granted });

    assert.equal(
      runs.length,
      1,
      "a GRANTED host cursor child was spawned and its bus server never approved — " +
        "`cursor-agent mcp list` reports `chat: not loaded (needs approval)` and the " +
        "agent has no `send` at all",
    );

    const approval = runs[0];

    // 🛑 THE VENDOR'S OWN BINARY, NOT A HARDCODED NAME. `cursor-agent` is not
    // on PATH on this host — it lives at `~/.local/bin/cursor-agent` — so a
    // bare name would resolve to nothing and the approval would not happen.
    assert.equal(approval.command, cursorSpawn.binary);

    // 🛑 THE SERVER ID MUST BE THE KEY THE CONFIG WRITES. `chatMcpServerConfig`
    // names it and `mcp enable` takes that same identifier. Two literals would
    // drift without failing anything, because `enable` against an id no config
    // declares is not an error the child ever reports — it just has no tools.
    assert.deepEqual([...approval.args], ["mcp", "enable", "chat"]);

    // 🛑 THE CHILD'S CWD, BECAUSE THE APPROVAL IS PER PROJECT. Cursor records
    // it under `~/.cursor/projects/<slug>/mcp-approvals.json`, so an approval
    // run in the supervisor's own directory approves a different project and
    // leaves the child deaf. Measured: the slug is built from the cwd's REAL
    // path, which is why this asserts the cwd we passed and not a derived one.
    assert.equal(approval.cwd, granted);

    // 🛑 AN UNGRANTED CHILD IS APPROVED NOTHING. It was promised no bus, and an
    // approval written for it mutates the operator's Cursor state for a server
    // that child cannot use.
    spawnOnHost(cursorSpawn, { cwd: ungranted });

    assert.equal(
      runs.length,
      1,
      "spawnOnHost approved a bus server for an UNGRANTED child",
    );

    // 🛑 A FLAGS-DELIVERED VENDOR REACHES NEITHER THE WRITE NOR THE APPROVAL.
    //
    // ⚠️ THIS IS NOT A CONTROL ON THE `hostGrantApproveArgs` GUARD, AND IT
    // READ AS ONE. Measured: making the approver run for every vendor left
    // this assertion GREEN, because `hostGrantDelivery === "file"` already
    // excludes claude one line earlier. So the claim it actually pins is the
    // DELIVERY branch, and the guard is pinned directly below instead.
    spawnOnHost(claudeSpawn, { grant: grantIn(claude), cwd: claude });

    assert.equal(
      runs.length,
      1,
      "spawnOnHost ran an approval for a FLAGS-delivered vendor, which does not " +
        "reach the host grant branch at all",
    );

    // 🛑 A REFUSED APPROVAL FAILS THE SPAWN RATHER THAN STARTING A DEAF CHILD.
    // A warning here leaves a child with no `send`, which is indistinguishable
    // from #348 and from a model that chose not to answer.
    refuse = true;

    assert.throws(
      () => spawnOnHost(cursorSpawn, { grant: grantIn(refused), cwd: refused }),
      (err: Error) => {
        // 🛑 THE MESSAGE NAMES THE CONSEQUENCE AND CARRIES THE CLI's STDERR.
        // "Command failed" alone sends the operator to the spawn layer; the
        // actionable facts are that the child would have had no bus tools and
        // whatever the CLI said about why.
        assert.match(err.message, /APPROVED/);
        assert.match(err.message, /no bus tools/);
        assert.match(err.message, /unknown MCP server 'chat'/);

        // 🛑 THE CREDENTIAL IS GONE AND THE DIAGNOSIS IS NOT. This message
        // reaches logs and chat, so a vendor echoing a key would publish it.
        // Redacting the whole stderr instead would be a different bug: the
        // operator would lose the only line saying why the approval failed.
        assert.doesNotMatch(err.message, new RegExp(SECRET));
        assert.match(err.message, /«redacted»/);

        return true;
      },
    );
  } finally {
    for (const dir of [granted, ungranted, claude, refused]) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

/**
 * 🛑 THE `hostGrantApproveArgs` GUARD, AIMED AT THE ACTOR THAT CAN ACTUALLY
 * REACH IT.
 *
 * Driving it through `spawnOnHost(claudeSpawn, …)` tests nothing: claude
 * declares `hostGrantDelivery: "flags"`, so it never enters the branch the
 * approver lives in. A mutant that approved EVERY vendor left that assertion
 * green — measured, twice, in two different specs.
 *
 * **The reachable actor is a vendor that declares `"file"` delivery and no
 * approval subcommand**, which is every future CLI whose config is enough on
 * its own. Without the guard it meets `undefined(...)` and the spawn dies with
 * a TypeError naming nothing an operator can act on.
 *
 * ⚠️ IT CALLS THE APPROVER DIRECTLY, AND THEREFORE NEEDS NO MODULE MOCK. There
 * is no CLI to execute, because the whole claim is that nothing is executed.
 */
test("🛑 a FILE-delivered vendor with no approval subcommand is approved nothing", async () => {
  const { approveHostGrantServer } =
    await import("../../../src/supervise/drivers/host-grant.js");

  const cwd = mkdtempSync(join(tmpdir(), "chat-mcp-approve-noargs-"));

  try {
    assert.equal(
      approveHostGrantServer(
        {
          vendor: "needs-no-approval",
          binary: "/nonexistent/binary",
          authEnvVar: "NEEDS_NO_APPROVAL_TOKEN",
        },
        cwd,
      ),
      undefined,
      "the approver ran something for a vendor that declares no approval step",
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
