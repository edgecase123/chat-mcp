import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { reapThenRemove } from "../../support/reap.js";

/**
 * 🛑 THE UNIT TESTS PROVE THE RESOLVER. THIS ONE PROVES SOMETHING CALLS IT.
 *
 * `test/util/handle-default.test.ts` exercises `resolveDefaultHandle` directly,
 * and a correct resolver that no command invokes would leave every unnamed
 * operator registered as the shared literal `"user"` exactly as before. So
 * this file starts the real server and reads the handle out of its banner.
 *
 * ⚠️ ONE SPAWN, DELIBERATELY. Two `node --import tsx` children inside an
 * already-parallel suite run crashed an unrelated worker with `ERANGE` out of
 * tsx's CJS transformer. The precedence between the flag and the env var is
 * asserted at the unit layer instead, where it costs no process at all.
 */

const CLI = new URL("../../../src/index.ts", import.meta.url).pathname;

/** The banner's handle field, from `src/cli/web/server.ts`. */
const BANNER = /chat-mcp web\s+·\s+(\S+)/;

/**
 * Start `chat-mcp web`, read until the banner names a handle, then stop.
 *
 * ⚠️ `--port 0` AND A TEMP `CHAT_MCP_HOME`, so this cannot collide with an
 * operator's running server or unlink their live sockets. The handle is short
 * on purpose: a temp state dir runs 69-75 bytes against macOS's ~104-byte
 * socket cap, so a long handle fails the bind in a test while production
 * accepts it.
 */
async function webBanner(env: Record<string, string>): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "chat-mcp-handle-"));
  const child = spawn(
    process.execPath,
    ["--import", "tsx", CLI, "web", "--no-open", "--port", "0"],
    {
      env: { ...process.env, CHAT_MCP_HOME: join(root, "state"), ...env },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let out = "";
  try {
    return await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`no banner within 30s. output so far:\n${out}`));
      }, 30_000);

      const settle = (err?: Error) => {
        clearTimeout(timer);
        if (err) return reject(err);
        resolve(out);
      };

      const absorb = (chunk: Buffer) => {
        out += chunk.toString("utf8");
        if (BANNER.test(out)) settle();
      };

      child.stdout.on("data", absorb);
      child.stderr.on("data", absorb);
      child.on("error", settle);
      child.on("exit", () => settle());
    });
  } finally {
    // 🛑 REAPED BEFORE REMOVED, NEVER SIGNALLED-THEN-REMOVED. #351: `kill` does
    // not reap, so this child could still be writing `chat.db-wal` inside
    // `root` while `rmSync` walked it, and the `ENOTEMPTY` landed on whatever
    // diff was in the tree.
    await reapThenRemove(child, root);
  }
}

test("🛑 `chat-mcp web` with no --handle registers the RESOLVED handle, not the shared literal", async () => {
  const banner = await webBanner({ CHAT_MCP_HANDLE: "webwiring" });
  const named = BANNER.exec(banner);

  assert.ok(named, `no handle in the banner:\n${banner}`);
  assert.equal(named[1], "webwiring");

  // The control that makes the assertion above dispositive: `"user"` is what
  // the old hardcoded default produced, and the banner is the only place the
  // registered handle is published.
  assert.ok(
    !/·\s+user\s/.test(banner),
    `the banner still names the old shared default:\n${banner}`,
  );
});
