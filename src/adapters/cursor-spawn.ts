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
  routeCursorEvent,
} from "../supervise/drivers/cursor.js";
import { CURSOR_IMAGE_TAG } from "../supervise/container.js";

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

  /**
   * 🛑 DOCKER GETS THE PATH CURSOR READS; THE HOST STILL GETS THE GRANT'S.
   * The refusal this replaces applied to BOTH modes and only ever had a reason
   * in one: writing `~/.cursor/mcp.json` on the HOST clobbers the human's own
   * Cursor configuration. There is no operator config inside the image, so in
   * a container the objection describes a file that does not exist (#372).
   *
   * ⚠️ THE HOST PATH IS THEREFORE STILL UNWIRED, AND STILL ON PURPOSE. A host
   * Cursor child reaches no bus, because the only way to wire it is the file
   * this project may not own. That is a separate decision from this one.
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
  mcpConfigFlags: (_path: string): readonly string[] => [],

  routeEvent: routeCursorEvent,

  encodeInput: cursorEncodeInput,

  redispatchPrompt: cursorRedispatchPrompt,
};
