import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * How to launch this build of chat-mcp as the child's MCP server.
 *
 * 🛑 RESOLVED MODULE-RELATIVE, NEVER FROM `process.argv[1]`. argv[1] was used
 * here to mean "the chat-mcp entry point". It means "whatever script is
 * running right now". Under the installed bin those coincide; under a script
 * or a test they do not, so a child got
 * `node scripts/supervise-live.mjs --handle ...` and had NO chat tool at all.
 * It woke, ran its turn, and could not answer. Found by the live harness —
 * every unit test here asserted the handle and none asserted the command.
 *
 * `package.json` ships only `dist`, so from `dist/supervise/child.js` the
 * sibling `../index.js` is the installed `bin`. Running from source there is
 * no `../index.js`, and the TypeScript entry needs a loader or the child exits
 * immediately — which looks exactly like the bug above.
 */
export function resolveChatMcpEntry(): { command: string; args: string[] } {
  // 🚨 THESE ARE RELATIVE TO drivers/, AND THEY WERE OFF BY ONE LEVEL.
  // `../index.ts` from `src/supervise/drivers/` is `src/supervise/index.ts`
  // — the SUPERVISOR, not the CLI. The child's MCP server launched the
  // supervisor, which exits immediately, so every child reported
  // `chat: failed, Connection closed` and had no bus tools at all.
  //
  // ⚠️ THE EXISTING TEST COULD NOT SEE IT: it asserted the file EXISTS and
  // is named `index.(js|ts)`, and the supervisor satisfies both. Third bug
  // of this exact shape tonight.
  //
  // Installed layout: dist/supervise/drivers/claude.js -> dist/index.js
  const built = fileURLToPath(new URL("../../index.js", import.meta.url));
  if (existsSync(built)) return { command: process.execPath, args: [built] };

  // Source layout with a build present — preferred, because it needs no loader
  // and therefore nothing to resolve from the child's cwd.
  const builtFromSource = fileURLToPath(
    new URL("../../../dist/index.js", import.meta.url),
  );
  if (existsSync(builtFromSource))
    return { command: process.execPath, args: [builtFromSource] };

  // Source layout with no build. The loader has to be an ABSOLUTE path.
  const source = fileURLToPath(new URL("../../index.ts", import.meta.url));
  if (existsSync(source)) {
    return {
      command: process.execPath,
      args: ["--import", resolveLoader(), source],
    };
  }

  throw new Error(
    `cannot locate the chat-mcp entry point next to ${import.meta.url}; ` +
      "pass an explicit entry to writeClaudeMcpConfig",
  );
}

/**
 * The tsx loader as an ABSOLUTE path.
 *
 * 🛑 `--import tsx` IS A BARE SPECIFIER AND THE CHILD RESOLVES IT FROM ITS OWN
 * CWD. The supervised child runs in whatever directory the operator chose, and
 * the live harness uses an empty temp dir — which has no `node_modules` above
 * it, so the chat server died with `ERR_MODULE_NOT_FOUND` the instant it
 * started. The agent then had no chat tool and WROTE OUT the call it could not
 * make, which reads like a model failure rather than a missing dependency.
 *
 * ⚠️ SECOND INSTANCE OF ONE MISTAKE. The script path was already absolute; the
 * loader name was not. Any part of this command line that is resolved rather
 * than stated is resolved against the CHILD's cwd, not ours.
 */
function resolveLoader(): string {
  return fileURLToPath(import.meta.resolve("tsx"));
}

/**
 * The key this project's MCP server block is written under, and therefore the
 * identifier a CLI's own approval subcommand takes.
 *
 * 🛑 ONE LITERAL, BECAUSE A SECOND ONE CANNOT FAIL. `cursor-agent mcp enable`
 * takes this exact id, and `enable` against an id no config declares is not an
 * error the child ever reports — it just starts with no bus tools. So a drifted
 * copy reproduces #348 and every test stays green.
 */
export const CHAT_MCP_SERVER_ID = "chat";

/**
 * The shape `chatMcpServerConfig` returns, keyed off the constant.
 *
 * 🛑 THE RETURN TYPE WAS THE THIRD COPY OF THE LITERAL, one line below the
 * constant that exists to be the only one. A type is not exempt: renaming the
 * constant without renaming the type gives a value whose declared key and
 * actual key disagree, and `tsc` is then the only thing that notices.
 * claude1's 🔵 on PR 394.
 */
export type ChatMcpServerConfig = {
  mcpServers: Record<
    typeof CHAT_MCP_SERVER_ID,
    { command: string; args: string[] }
  >;
};

/**
 * The MCP server block that points a child at THIS build of the bus.
 *
 * 🛑 ONE BUILDER FOR EVERY VENDOR, BECAUSE THE SERVER IS NOT A VENDOR'S
 * BUSINESS. It used to be inlined in `writeClaudeMcpConfig`, which meant a
 * second CLI wired to the bus had to either import the Claude driver or
 * restate the block — and a restated one drifts without failing anything.
 *
 * 🛑 THE CHILD GETS A HANDLE OF ITS OWN. `inbox` marks messages read, so a
 * child sharing the supervisor's handle silently consumes the deliveries meant
 * for it. See chat-mcp#35.
 *
 * ⚠️ THE COMMAND IS THIS PROCESS'S OWN INTERPRETER AND THIS BUILD'S OWN ENTRY
 * POINT, never a fresh `npx` fetch. A child on a different build of the bus
 * than the process delivering to it is the drift chat-mcp#382 is about. It is
 * also lee's security bound of 2026-11-21: this file is written into the
 * agent's project directory, so the command it names is an execution surface
 * and must be one this build already runs.
 */
export function chatMcpServerConfig(
  handle: string,
  entry?: string,
): ChatMcpServerConfig {
  const launch = entry
    ? { command: process.execPath, args: [entry] }
    : resolveChatMcpEntry();

  return {
    mcpServers: {
      [CHAT_MCP_SERVER_ID]: {
        command: launch.command,
        args: [...launch.args, "--handle", handle],
      },
    },
  };
}
