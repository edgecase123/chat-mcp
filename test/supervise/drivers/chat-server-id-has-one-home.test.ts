import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 🛑 BEFORE any import that resolves a state path, per AGENTS.md. Both config
// builders sit in modules that reach the state dir transitively.
process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), "chat-mcp-serverid-"));

const { CHAT_MCP_SERVER_ID, chatMcpServerConfig } =
  await import("../../../src/supervise/drivers/chat-mcp-server.js");
const { buildContainerMcpConfig } =
  await import("../../../src/supervise/drivers/containerized.js");
const { cursorSpawn } = await import("../../../src/adapters/cursor-spawn.js");

/**
 * 🛑 THE KEY THE CONFIG DECLARES AND THE ID THE APPROVAL NAMES MUST BE THE
 * SAME STRING, AND NOTHING ELSE MAKES THEM AGREE.
 *
 * `cursor-agent mcp enable <id>` takes the key from `mcpServers`. An `enable`
 * against an id no config declares is **not an error any child reports** — the
 * CLI accepts it and the server simply stays unapproved, so the agent starts
 * cleanly with no bus tools. That is #348's exact failure mode, which means a
 * drift between these two strings is silent in both the code and the logs.
 *
 * ⚠️ IT ASSERTS THE RESOLVED VALUES, NOT A COUNT OF THE LITERAL. A grep for
 * `"chat"` cannot tell a shared constant from a second hardcoded copy, and the
 * container builder WAS a second hardcoded copy — found by review on PR 394,
 * after a docblock in this very constant's file claimed there was only one.
 */
test("🛑 the host config, the container config and the approval all name ONE server id", () => {
  const host = chatMcpServerConfig("h-child");

  assert.deepEqual(
    Object.keys(host.mcpServers),
    [CHAT_MCP_SERVER_ID],
    "the HOST config declares a server key that is not the shared id",
  );

  // 🛑 THE CONTAINER BUILDER IS THE ONE THAT DRIFTED. It takes an endpoint
  // rather than a handle, so it is a separate code path that no host test
  // reaches — which is why its hardcoded copy survived until a reviewer read it.
  const contained = JSON.parse(
    buildContainerMcpConfig({
      url: "http://127.0.0.1:1/mcp",
      token: "t-not-a-real-token",
    }),
  ) as { mcpServers: Record<string, unknown> };

  assert.deepEqual(
    Object.keys(contained.mcpServers),
    [CHAT_MCP_SERVER_ID],
    "the CONTAINER config declares a server key that is not the shared id",
  );

  // 🛑 AND THE APPROVAL ARGV CARRIES THAT SAME VALUE. This is the clause that
  // makes the other two matter: the config may be internally consistent and
  // still be approved under a different name.
  assert.ok(
    cursorSpawn.hostGrantApproveArgs,
    "cursor declares no approval step",
  );

  assert.deepEqual(
    [...cursorSpawn.hostGrantApproveArgs(CHAT_MCP_SERVER_ID)],
    ["mcp", "enable", CHAT_MCP_SERVER_ID],
  );

  // 🛑 THE SERVED VALUE, PINNED AS A LITERAL EXACTLY ONCE. Every assertion
  // above compares the constant to itself and would stay green if the constant
  // changed, so one of them has to name the real string. Changing Cursor's
  // expected key is a deliberate act that should redden a test.
  assert.equal(CHAT_MCP_SERVER_ID, "chat");
});
