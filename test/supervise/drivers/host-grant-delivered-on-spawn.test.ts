import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { ChildGrant } from "../../../src/supervise/grant.js";

/**
 * 🛑 THE WRITER BEING CORRECT IS NOT THE WRITER BEING CALLED.
 *
 * `host-grant-file.test.ts` drives `deliverHostGrantFile` directly, and a
 * negative control proved that is not enough: deleting the call from
 * `spawnOnHost` left all 19 of those tests GREEN. So slice 2 could have
 * shipped with a correct writer that nothing invoked, which is #348's silence
 * with an extra file in the repo.
 *
 * ⚠️ IT EXECUTES NO CLI. `node:child_process` is mocked, the instrument
 * `host-binary-override.test.ts` and `containerized.test.ts` already use.
 */

/**
 * 🛑 `configPath` POINTS INSIDE THE TEMP CWD, NOT AT A FIXED `/tmp` NAME.
 * A mutant that made the writer land `grant.configPath` left a real file at a
 * shared path, and the NEXT run then failed on it — so a passing suite
 * depended on run order and the failure read as a code defect. Measured: the
 * state-dir control reddened on a clean tree only.
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

/**
 * 🛑 ONE TEST FOR ALL THREE CASES, ON PURPOSE. The module mock reverts with
 * the test context, and a second test would meet an already-imported
 * `host.js` — so the delivery, the ungranted control and the cwd are asserted
 * against one recording.
 */
test("🛑 spawnOnHost DELIVERS the grant file for cursor, and only when granted", async (t: TestContext) => {
  const cwds: (string | undefined)[] = [];

  const approvals: { command: string; cwd?: string }[] = [];

  t.mock.module("node:child_process", {
    namedExports: {
      spawn: (_command: string, _args: string[], opts: { cwd?: string }) => {
        cwds.push(opts?.cwd);

        return fakeChild();
      },
      // 🛑 THE APPROVAL STEP SHELLS OUT, AND MOCKING ONLY `spawn` LEFT IT REAL.
      // This test passed on a laptop that has `cursor-agent` installed and
      // failed on CI, which does not: the real `execFileSync` ENOENTed, the
      // catch in `approveHostGrantServer` read the vendor token, and the
      // `CHAT_MCP_HOME` guard threw a message about state dirs. Green here
      // depended on a binary this test never meant to run.
      execFileSync: (
        command: string,
        _args: string[],
        opts: { cwd?: string },
      ) => {
        approvals.push({ command, cwd: opts?.cwd });

        return "";
      },
    },
  });

  // 🛑 THE VENDOR IS IMPORTED INSIDE THE TEST, AFTER THE MOCK.
  // `cursor-spawn.js` pulls in `host-grant.js`, which binds `execFileSync` at
  // module load — so a top-level import of the vendor captures the real one
  // before `t.mock.module` has run at all.
  const { spawnOnHost } =
    await import("../../../src/supervise/drivers/host.js");
  const { cursorSpawn } = await import("../../../src/adapters/cursor-spawn.js");

  const granted = mkdtempSync(join(tmpdir(), "chat-mcp-spawn-granted-"));
  const ungranted = mkdtempSync(join(tmpdir(), "chat-mcp-spawn-ungranted-"));

  try {
    spawnOnHost(cursorSpawn, { grant: grantIn(granted), cwd: granted });

    const path = join(granted, ".cursor", "mcp.json");

    assert.ok(
      existsSync(path),
      "spawnOnHost spawned a GRANTED cursor child and wrote it no config",
    );

    // 🛑 THE CONTENT, NOT JUST THE FILE. An empty file at the right path would
    // satisfy existsSync and leave the agent with no bus.
    const written = JSON.parse(readFileSync(path, "utf8")) as {
      mcpServers: { chat: { args: string[] } };
    };
    assert.ok(written.mcpServers.chat.args.includes(grantIn(granted).handle));

    // 🛑 THE UNGRANTED CASE IS #348's OWN WORKAROUND AND MUST STAY CLEAN. A
    // file planted for a child that was promised no bus is litter in the
    // operator's project directory.
    spawnOnHost(cursorSpawn, { cwd: ungranted });

    assert.ok(
      !existsSync(join(ungranted, ".cursor")),
      "spawnOnHost wrote a grant config for an UNGRANTED child",
    );

    // 🛑 AND NOTHING HAS SPAWNED YET, WHICH IS THE POINT. `cursor-agent` is
    // `processPerTurn`, so `wirePerTurnChild` launches lazily — the config is
    // therefore on disk BEFORE the first process exists, which is the only
    // ordering that works for a CLI that reads it at startup.
    //
    // ⚠️ MEASURED, NOT ASSUMED. This assertion was first written as
    // `[granted, ungranted]` on the belief that `spawnOnHost` execs
    // immediately. The mock recorded zero calls and corrected it.
    assert.deepEqual(cwds, [], "a per-turn vendor spawned at wiring time");

    // 🛑 ONE APPROVAL, IN THE GRANTED CHILD'S OWN DIRECTORY.
    // Recording the command alone proved only "exactly one": a mutant that
    // approved the UNGRANTED child INSTEAD of the granted one still pushed a
    // single entry naming the same binary, and stayed green. The approval is
    // recorded per project directory, so the `cwd` is the half that says which
    // child got a bus. claude1 on PR 394.
    assert.deepEqual(
      approvals,
      [{ command: cursorSpawn.binary, cwd: granted }],
      "the bus server was approved for the wrong child, or in the wrong directory",
    );
  } finally {
    rmSync(granted, { recursive: true, force: true });
    rmSync(ungranted, { recursive: true, force: true });
  }
});
