import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeSpawn } from "../../../src/adapters/claude-spawn.js";

// 🛑 BEFORE any import that resolves a state path, per AGENTS.md. `spawnOnHost`
// reads the vendor token on every spawn since #396, and `auth.ts` resolves the
// state dir — which the node runner refuses when it is the operator's live
// `~/.chat-mcp`.
process.env.CHAT_MCP_HOME = mkdtempSync(
  join(tmpdir(), "chat-mcp-host-override-home-"),
);

/**
 * 🛑 NOTHING PROTECTED `--binary` ON THE HOST, AND A SOURCE-GREP TEST HID IT.
 *
 * PR 388's first cut asserted that `host.ts` CONTAINS the string
 * `turnOpts.binary ?? vendor.binary`. claude2 broke the live `spawn()` call
 * while leaving that string in a comment above it: the control passed, and so
 * did all 2514 tests. The override could have been deleted from the driver
 * without one test going red.
 *
 * This asserts the ARGUMENT `spawn` receives instead, which is the behaviour.
 * It executes no CLI — `node:child_process` is mocked, the same instrument
 * `containerized.test.ts` uses five times.
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

/**
 * 🛑 ONE TEST FOR BOTH CASES, ON PURPOSE. The mock reverts with the test
 * context and a second test would meet an already-imported `host.js`, so the
 * override and its control are asserted against one recording.
 *
 * ⚠️ A LITERAL SPECIFIER, NOT A CACHE-BUSTING TEMPLATE ONE.
 * `typecheck-config.test.ts` pins the count of template-literal imports
 * because each one types as `any`, and this file needs no fresh instance: it
 * is the first importer of `host.js` in its own run.
 */
test("🛑 the HOST spawn execs an explicit binary, and the vendor's own without one", async (t: TestContext) => {
  const execd: string[] = [];

  t.mock.module("node:child_process", {
    namedExports: {
      spawn: (command: string) => {
        execd.push(command);

        return fakeChild();
      },

      // 🛑 PRESENT BECAUSE `host-grant.ts` IMPORTS IT, AND ABSENT IT BREAKS
      // THE IMPORT RATHER THAN A CALL. A mock's `namedExports` IS the module
      // for everything loaded after it, so a missing name fails with
      // "does not provide an export named 'execFileSync'" from a file this
      // test never calls into. Measured when the host grant approval landed.
      //
      // 🛑 IT THROWS, SO IT DOUBLES AS A CONTROL. This test spawns CLAUDE,
      // which delivers its grant by flags and declares no approval step — so
      // nothing here may exec a second process. A change that approved
      // unconditionally would reach this and say why.
      execFileSync: (command: string, args: readonly string[]) => {
        throw new Error(
          `the HOST spawn exec'd a second process for a FLAGS-delivered vendor: ` +
            `${command} ${args.join(" ")}`,
        );
      },
    },
  });

  const { spawnOnHost } =
    await import("../../../src/supervise/drivers/host.js");
  const { setVendorToken } = await import("../../../src/supervise/auth.js");

  // 🛑 A TOKEN ON FILE, BECAUSE AN UNAUTHENTICATED CHILD IS NOW REFUSED AT
  // SPAWN. #396. Without it both spawns below throw and `execd` stays empty,
  // which reads as the override having been deleted.
  setVendorToken(claudeSpawn, "claude-token-for-the-override-spawns");

  spawnOnHost(claudeSpawn, { binary: "/Users/me/.local/bin/claude" });
  spawnOnHost(claudeSpawn, {});

  assert.deepEqual(execd, ["/Users/me/.local/bin/claude", claudeSpawn.binary]);
});
