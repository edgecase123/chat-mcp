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
   * 🛑 A chat-mcp-OWNED PATH, NOT THE `~/.cursor/mcp.json` CURSOR READS.
   * Writing that file would overwrite the human's own Cursor configuration,
   * and nothing in this project may clobber a file the user owns.
   *
   * ⚠️ THE CONSEQUENCE IS STATED RATHER THAN HIDDEN: with `mcpConfigFlags`
   * empty, a Cursor child does not reach the bus. **Whether `cursor-agent`
   * accepts any config-path flag is UNMEASURED** — the #317 measurement
   * covered the flags it needed to run, not this one. Until it is measured,
   * failing with no bus is the correct behaviour, because the alternative
   * fails by destroying the operator's config.
   */
  mcpConfigFor: (grant: ChildGrant, _mode: SandboxMode): string =>
    grant.configPath,

  /**
   * ⚠️ EMPTY IS A REAL ANSWER HERE, AND ALSO AN UNFINISHED ONE. The contract
   * documents an empty array as the answer for a CLI that reads a fixed
   * location. Cursor does read a fixed location — one this build deliberately
   * does not write. See `mcpConfigFor`.
   */
  mcpConfigFlags: (_path: string): readonly string[] => [],

  routeEvent: routeCursorEvent,

  encodeInput: cursorEncodeInput,

  redispatchPrompt: cursorRedispatchPrompt,
};
