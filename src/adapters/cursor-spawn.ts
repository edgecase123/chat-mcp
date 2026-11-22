import type { SpawnOptions } from "../supervise/child.js";
import type { ChildGrant } from "../supervise/grant.js";
import type { SandboxMode, VendorSpawn } from "../supervise/vendor.js";
import {
  CURSOR_CONTAINER_BINARY,
  CURSOR_CONTAINER_HOME,
  CURSOR_HOST_BINARY,
  cursorArgs,
  cursorEncodeInput,
  cursorRedispatchPrompt,
  cursorResumeFlags,
  routeCursorEvent,
} from "../supervise/drivers/cursor.js";
import { CURSOR_IMAGE_TAG } from "../supervise/container.js";
import { cursorProjectMcpConfigPath } from "../supervise/drivers/host-grant.js";

/**
 * The ONLY place a containerized `cursor-agent` looks for an MCP config.
 *
 * 🛑 A FIXED PATH, BECAUSE THERE IS NO FLAG. `cursor-agent mcp --help` names
 * `.cursor/mcp.json or ~/.cursor/mcp.json` and the binary's 24 long flags
 * include no config-path option at all — measured on #372. So this string is
 * the wiring, and a wrong one fails by starting cleanly and answering nothing.
 *
 * 🛑 WRITTEN ONLY INSIDE THE CONTAINER. The image has no operator config to
 * overwrite, which is why the host path keeps the old refusal.
 *
 * ⚠️ BUILT FROM `CURSOR_CONTAINER_HOME` RATHER THAN SPELLED `/root`, because
 * the CLI's rule is literally `$HOME/.cursor/mcp.json`. An image that moved
 * HOME must move this file with it, and one constant cannot do that alone.
 */
const CURSOR_CONTAINER_MCP_CONFIG_PATH = `${CURSOR_CONTAINER_HOME}/.cursor/mcp.json`;

/**
 * Cursor's spawn contract: the only place this CLI's flag names live.
 *
 * 🛑 THE SAME FLAG SET IN BOTH SANDBOX MODES, UNLIKE CLAUDE CODE. Claude's two
 * sets diverge because its host path negotiates permissions through prompts and
 * its container path skips them. Cursor's tool gate is `--force`, which is
 * needed on the host too, so there is nothing for the container to drop.
 */
export const cursorSpawn: VendorSpawn = {
  vendor: "cursor",
  binary: CURSOR_HOST_BINARY,

  // 🛑 THE TWO PATHS ARE DIFFERENT FILES, AND THAT IS THE WHOLE POINT OF THE
  // SECOND FIELD. The host installer writes under `homedir()`; the image
  // symlinks into `/usr/local/bin`.
  containerBinary: CURSOR_CONTAINER_BINARY,

  image: CURSOR_IMAGE_TAG,
  containerHome: CURSOR_CONTAINER_HOME,
  containerMcpConfigPath: CURSOR_CONTAINER_MCP_CONFIG_PATH,
  authEnvVar: "CURSOR_API_KEY",

  /**
   * 🛑 A DASHBOARD, NOT A CLI COMMAND. `cursor-agent login` stores a login on
   * the host that a Linux container cannot read — `apiKeySource: "login"` in
   * its own init event. Only a dashboard-issued key reaches a container, and a
   * fine-grained one was measured working on #347: `apiKeySource: "env"`.
   */
  authSetupHint:
    "create a Cursor API key at https://cursor.com/dashboard/api (a host login cannot be read by a container)",

  /**
   * 🛑 BOTH FALSE, AND THIS CORRECTS MY OWN MEASUREMENT NOTE ON #317.
   *
   * That note recorded `reportsUsage: TRUE` because `result.usage` carries
   * five token-count fields. **Token counts are not what this field means.**
   * `reportsUsage` promises the `usage` sink will be called with a
   * `RateLimitSnapshot`, which is subscription-window state — a status, an
   * overage flag and named windows. Cursor reports no such thing.
   *
   * ⚠️ DECLARING `true` HERE WOULD REPRODUCE #219 EXACTLY: the operator is
   * told a reading is coming and waits for it forever, because
   * `routeCursorEvent` never calls that sink.
   *
   * `reportsContext` is false for the measured reason — no window TOTAL
   * appears anywhere in the stream, and a used-without-total cannot make a
   * percentage. #135's context gate therefore cannot cover a Cursor handle.
   */
  reportsUsage: false,
  reportsContext: false,

  /**
   * 🛑 TRUE, AND IT IS THE WHOLE REASON UNIT 1 EXISTED. `cursor-agent -p`
   * reads its prompt from stdin to EOF and exits when the turn is done, so one
   * turn costs one process and an exit is NOT the agent dying.
   *
   * ⚠️ A CURSOR HANDLE IS THEREFORE OFFLINE BETWEEN TURNS, because the MCP
   * shim is a child of the turn's process and dies with it. **Cursor cannot be
   * the test vehicle for a long-lived-stdio goal.** Measured on #317.
   */
  processPerTurn: true,

  argsFor: (opts: SpawnOptions, _mode: SandboxMode): string[] =>
    cursorArgs(opts),

  resumeFlags: cursorResumeFlags,

  /**
   * 🛑 ONE CALL SITE, IN `containerized.ts`, SO ONLY THE DOCKER ARM IS READ.
   * The host arm is unreachable today and kept rather than thrown from,
   * because a library caller may still ask. A host grant does NOT travel
   * through here — it is delivered by `hostGrantConfigPath` below, which this
   * signature cannot express because it takes no cwd (#348).
   */
  mcpConfigFor: (grant: ChildGrant, mode: SandboxMode): string =>
    mode === "docker" ? CURSOR_CONTAINER_MCP_CONFIG_PATH : grant.configPath,

  /**
   * 🛑 EMPTY IS THE REAL ANSWER, AND IT IS NO LONGER AN UNFINISHED ONE.
   * `cursor-agent` has NO config-path flag — measured on #372 against the live
   * binary's 24 long flags, not read off its docs. So the file landing at
   * `containerMcpConfigPath` is the entire wiring, and there is nothing for a
   * flag to add.
   *
   * ⚠️ `--approve-mcps` IS WHAT MAKES THE FILE TAKE EFFECT, and it is already
   * in `cursorArgs`. Without it the server is prompted for, and a supervised
   * child has no TTY to answer with.
   */
  /**
   * 🛑 `"file"`, AND IT IS WHY A GRANTED HOST CURSOR CHILD NOW STARTS INSTEAD
   * OF BEING REFUSED. `cursor-agent mcp --help` names
   * `.cursor/mcp.json or ~/.cursor/mcp.json`, and a cwd-relative
   * `.cursor/mcp.json` IS read — measured on #348 against an empty-cwd
   * control. `hostGrantConfigPath` below is where it lands.
   *
   * 🛑 WRITING IT CHANGES NO ARGV, WHICH IS THE WHOLE REASON THIS FIELD IS A
   * DECLARATION. Both agents independently proposed inferring the route from
   * the argv, and both inferences were measured wrong: a granted host Cursor
   * child's argv is identical to an ungranted one's before AND after this
   * slice.
   *
   * ⚠️ `"file"` IS NOT SELF-ENFORCING. `assertHostGrantReachesBus` admits it
   * by NOT being `"none"`, so flipping this and forgetting the writer would
   * stop the refusal and restore the silence. `hostGrantConfigPathFor` throws
   * on that pair and `host-grant-file.test.ts` asserts the file LANDS.
   */
  hostGrantDelivery: "file",

  hostGrantConfigPath: cursorProjectMcpConfigPath,

  /**
   * 🛑 `.cursor/mcp.json` MAKES THE SERVER SEEN; THIS MAKES IT LOADED.
   *
   * Read off `cursor-agent mcp --help`, which documents `enable <identifier>`
   * as "Add an MCP server to the local approved list". Measured end to end in
   * an empty temp cwd: before it, `mcp list` says `chat: not loaded (needs
   * approval)` and `list-tools` refuses; after it, `chat: ready` with 24 tools.
   *
   * ⚠️ NOT A HAND-WRITTEN APPROVALS FILE, AND THAT WAS THE FIRST DESIGN. The
   * record lands at `~/.cursor/projects/<slug>/mcp-approvals.json` as
   * `["chat-<16 hex>"]`, where the suffix hashes the server's command+args and
   * the slug is built from the cwd's REAL path. Both are Cursor's internals;
   * writing them ourselves re-implements a hash we do not own.
   */
  hostGrantApproveArgs: (serverId: string) => ["mcp", "enable", serverId],

  mcpConfigFlags: (_path: string): readonly string[] => [],

  routeEvent: routeCursorEvent,

  encodeInput: cursorEncodeInput,

  redispatchPrompt: cursorRedispatchPrompt,
};
