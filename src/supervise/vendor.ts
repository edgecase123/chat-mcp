import type { SpawnOptions } from "./child.js";
import type { ChildGrant } from "./grant.js";
import type { Denial } from "./denial.js";
import type { RateLimitSnapshot } from "./rate-limit.js";
import type { ContextSnapshot } from "./context-gauge.js";
import type { RedispatchInput } from "./drivers/claude-redispatch.js";
import type { UnnamedToolCall } from "./child.js";

/**
 * The spawn contract, defined in the SUPERVISE layer rather than beside
 * `Adapter`.
 *
 * 🛑 THE DIRECTION IS THE POINT. `adapters/` imports from `supervise/` and
 * never the other way round. Putting these types next to `Adapter` would make
 * the generic spawners import `adapters/types.js`, which reverses one edge and
 * closes a cycle — a cycle no grep of the current tree can find, because the
 * spawners that would close it do not exist yet.
 */

/** Where a supervised child runs. */
export type SandboxMode = "host" | "docker";

/**
 * Map ONE parsed CLI event onto the supervisor's semantic callbacks.
 *
 * Each vendor writes its own. `routeClaudeEvent` is the Claude Code one.
 */
export type EventRouter = (
  event: Record<string, unknown>,
  on: {
    turnEnd(): void;
    usage(snapshot: RateLimitSnapshot): void;
    context?(snapshot: ContextSnapshot): void;
    denial?(denial: Denial): void;
    session?(id: string): void;

    /**
     * This turn called a tool, named if the vendor could read its name.
     *
     * 🛑 `null` MEANS "A TOOL CALL HAPPENED AND I COULD NOT NAME IT", AND IT
     * IS NOT THE SAME AS NOT CALLING THIS AT ALL. The supervisor logs it.
     * Cursor's event shape is read out of its shipped bundle rather than off
     * a captured stream, so a wrong field path is a live possibility — and
     * the failure mode of a wrong path is the SILENCE #392 is about.
     * Reporting `null` turns that guess into a signal.
     *
     * ⚠️ IT REPORTS EVERY TOOL, NOT ONLY BUS TOOLS. `isOutboundChatTool`
     * decides which ones matter, in one place, above the vendors.
     */
    toolCall?(name: string | null, why?: UnnamedToolCall): void;
  },
) => void;

/**
 * Everything the supervisor needs in order to spawn one vendor's CLI, in
 * either sandbox mode.
 *
 * 🛑 `argsFor` TAKES THE MODE because the two flag sets are mutually
 * exclusive. The host path passes `--permission-mode` and `--allowedTools`;
 * the container path passes `--dangerously-skip-permissions` and neither of
 * those, because the container boundary is the gate.
 *
 * ⚠️ THE FLAG NAME IS THE LOAD-BEARING PART. The near-identical
 * `--allow-dangerously-skip-permissions` only makes the bypass AVAILABLE; it
 * does not turn it on. The container passed that one alone for a week and
 * every agent in it was denied the bus tool it existed to call. A vendor owns
 * both sets, so no generic spawner has to know either.
 */
export interface VendorSpawn {
  /**
   * This vendor's name, as `--vendor` and `--driver` spell it.
   *
   * 🛑 SO A REFUSAL CAN PRINT A RUNNABLE COMMAND. The message told the
   * operator to run `auth set-token --vendor <name>` with the placeholder
   * still in it, because no value here knew the name. `spawn-contract.test.ts`
   * pins this against the registry's own `vendor`, so the two cannot drift.
   */
  readonly vendor: string;

  /** The CLI to exec on the HOST. */
  readonly binary: string;

  /**
   * The CLI to exec INSIDE the container, a different filesystem.
   *
   * 🛑 A SECOND FIELD BECAUSE ONE STRING CANNOT NAME TWO FILESYSTEMS. `binary`
   * alone was exec'd in both modes, and Cursor's is an absolute host path
   * under `homedir()`. A containerized Cursor agent exited 127 and reported as
   * a dead agent rather than a missing CLI, so it had never once started.
   *
   * 🛑 REQUIRED, NOT OPTIONAL, for the reason already written on `image`. An
   * optional field lets the next vendor inherit the host path silently, which
   * is this defect again under a new vendor's name.
   */
  readonly containerBinary: string;

  readonly image: string;
  /**
   * The container's `HOME`. The bus resolves its state dir from it, so an
   * image whose HOME differs from this value loses the bus silently.
   */
  readonly containerHome: string;

  /**
   * Where the bus config must land INSIDE the container for this CLI to read
   * it. The prelude writes it there; nothing on the host is touched.
   *
   * 🛑 PER VENDOR, BECAUSE ONE FILENAME IS NOT A LOCATION TWO CLIs AGREE ON.
   * A CLI with a config-path flag reads wherever it is pointed, so the name
   * is free. A CLI without one reads a FIXED path, so for it the path IS the
   * wiring — and one shared filename is a file it never opens. `cursor-agent`
   * has no such flag, so its containerized agent reached the bus never while
   * reporting a clean start (#372).
   *
   * ⚠️ THE OLD NAME IS NOT SPELLED HERE ON PURPOSE. `state-dir-perms.test.ts`
   * forbids any file but `paths.ts` from quoting the host state directory's
   * name, and it reads COMMENTS as well as code. See `claude-spawn.ts` for the
   * value this used to be.
   *
   * 🛑 REQUIRED, AND NO FRAMEWORK DEFAULT FROM `containerHome`. The same
   * argument as `containerBinary`: a default lets the next flagless vendor
   * inherit a path it does not read, which is this defect under a new name.
   *
   * ⚠️ A VENDOR MAY STILL BUILD ITS OWN VALUE FROM ITS OWN `containerHome`,
   * and `cursorSpawn` does. That is not the banned shape — `cursor-agent`'s
   * documented location is literally `$HOME/.cursor/mcp.json`, so the two are
   * the same fact rather than two constants that happen to agree.
   */
  readonly containerMcpConfigPath: string;

  readonly authEnvVar: string;

  /**
   * How an operator OBTAINS this vendor's credential, in one clause.
   *
   * 🛑 A VENDOR FIELD BECAUSE THE INSTRUCTION IS A VENDOR'S. `dockerRunPlan`
   * refuses a spawn with no credential on file, and its message sent every
   * vendor to `claude setup-token`. A Cursor operator following that is
   * pointed at the wrong CLI for a key that lives in a web dashboard.
   */
  readonly authSetupHint: string;

  /**
   * This vendor's CLI reports usage-window state, and its `routeEvent` calls
   * the `usage` sink.
   *
   * 🛑 DECLARED BY THE VENDOR, NOT BY THE WIRING. `wireAgentChild` hard-coded
   * `true` for every vendor while the sinks it promises are OPTIONAL on
   * `EventRouter`. So a vendor whose router never calls them still announced
   * that a reading was coming, and the operator was told "awaiting the first
   * reading" forever — the exact confusion #217 exists to end, defeated one
   * layer down. #219.
   *
   * ⚠️ NOT DERIVED FROM WHETHER `routeEvent` LOOKS LIKE IT ROUTES ONE. That
   * is inference from shape, one step from the inference from silence this
   * whole seam replaces.
   */
  readonly reportsUsage: boolean;

  /** This vendor's CLI reports context-window fullness. See `reportsUsage`. */
  readonly reportsContext: boolean;

  /**
   * This vendor's CLI exits after every turn, so one turn costs one process.
   *
   * 🛑 DECLARED, NOT INFERRED, for the same reason `reportsUsage` is — and
   * here the inference would be from the SHAPE of a long-lived stdin, which
   * looks identical either way until turn two silently goes unanswered.
   *
   * `false` is Claude Code: one process reads many prompts off a stream-json
   * stdin. `true` is `cursor-agent -p`, whose stdin IS the prompt, read to
   * EOF — measured on #317, not read off its docs.
   *
   * ⚠️ IT SELECTS A WIRING, NOT A FLAG. `spawnOnHost` reads it to choose
   * between `wireAgentChild` and `wirePerTurnChild`, which disagree about
   * what `send` does and about whether a process exit means the agent died.
   */
  readonly processPerTurn: boolean;

  readonly argsFor: (opts: SpawnOptions, mode: SandboxMode) => string[];

  /**
   * The flags that continue session `sessionId`, which `argsFor` must pass.
   *
   * 🛑 ASKABLE SEPARATELY BECAUSE THE TURN RELAY HAS NO `SpawnOptions`. It
   * runs inside the container, builds every turn's argv after the first from
   * the base argv it was handed, and knows only the id the last turn reported.
   * A vendor that spelled `--resume` inline inside `argsFor` left it nothing
   * to append, so turn two started a fresh session and the agent forgot the
   * task between turns.
   */
  readonly resumeFlags: (sessionId: string) => readonly string[];
  /** The config path to point the CLI at, written first if the mode needs it. */
  readonly mcpConfigFor: (grant: ChildGrant, mode: SandboxMode) => string;

  /**
   * The flags, if any, that point this CLI at `path`.
   *
   * 🛑 A VENDOR FIELD BECAUSE THE SPELLINGS ARE A VENDOR'S. The containerized
   * spawner used to push `--mcp-config` and `--strict-mcp-config` itself, so
   * the one generic spawner `argsFor` exists to keep flag-free knew two Claude
   * Code flag names. The second vendor to reach it would have been handed argv
   * it rejects.
   *
   * ⚠️ AN EMPTY ARRAY IS A REAL ANSWER, NOT A MISSING ONE. A CLI that reads a
   * fixed location needs the file written and no flag at all, and the write is
   * driven by `mcpConfigFor` either way.
   */
  readonly mcpConfigFlags: (path: string) => readonly string[];

  /**
   * How a HOST child's bus grant actually reaches its CLI.
   *
   * 🛑 DECLARED, BECAUSE BOTH WAYS OF INFERRING IT ARE MEASURABLY WRONG.
   * `mcpConfigFlags` being empty does not mean "no route": Cursor returns `[]`
   * from it and reaches the bus in a container through a written file, and the
   * host path never calls it at all — one call site, in `containerized.ts`.
   * Nor does argv identity between a granted and an ungranted child, because a
   * route delivered by writing a config file changes no argv either.
   *
   * 🛑 `"none"` IS THE ONLY VALUE THAT REFUSES, and a granted child is the
   * only one it refuses. An ungranted child reaching no bus is a working
   * configuration; one PROMISED a bus and given none is #219's shape.
   *
   * ⚠️ A POSITIVE DECLARATION CANNOT BE SATISFIED BY ACCIDENT, which an
   * inference can. `host-grant-reaches-bus.test.ts` pins each value against
   * the argv, so the field cannot become a comment that disagrees with the code.
   */
  readonly hostGrantDelivery: "flags" | "file" | "none";

  /**
   * Where a `"file"`-delivered host grant is written, given the child's cwd.
   *
   * 🛑 REQUIRED IN PRACTICE WHENEVER `hostGrantDelivery` IS `"file"`, and
   * optional only because this is a flat interface. `hostGrantConfigPathFor`
   * throws when the pair disagrees, and `host-grant-file.test.ts` pins that —
   * the type system cannot, because `tsconfig.json` includes `src/**` only, so
   * a test fake or a JavaScript vendor omitting it compiles and runs.
   *
   * ⚠️ IT IS NOT `mcpConfigFor`. That one takes no cwd, so it cannot name a
   * project-local file at all; its host arm returned the state dir, which is
   * the location `cursor-agent` never reads (#348).
   */
  readonly hostGrantConfigPath?: (cwd: string) => string;

  /**
   * The CLI subcommand that APPROVES this project's bus server, given its id.
   *
   * 🛑 WRITING THE CONFIG IS NOT ENOUGH FOR EVERY CLI, AND #348 SHIPPED
   * BELIEVING IT WAS. Measured against `cursor-agent` 2026.11.19 in a cwd
   * holding only the file this project writes:
   *
   *   mcp list        -> chat: not loaded (needs approval)
   *   mcp list-tools  -> MCP server "chat" has not been approved
   *   mcp enable chat -> chat: ready, 24 tools
   *
   * So the config makes the server SEEN and this makes it LOADED. A granted
   * host child without it starts cleanly and has no `send` — #348's silence.
   *
   * 🛑 OMITTED MEANS "NEEDS NO APPROVAL", WHICH IS CLAUDE'S REAL ANSWER. It is
   * not a missing declaration: a flags-delivered grant is live the moment the
   * child starts, and running a `mcp enable` against that binary would fail on
   * a subcommand it does not have.
   *
   * ⚠️ IT RETURNS ARGV AND RUNS NOTHING. The vendor names the command; the
   * host driver owns the execution, the cwd and the refusal — the same split
   * `hostGrantConfigPath` uses, for the same reason.
   */
  readonly hostGrantApproveArgs?: (serverId: string) => readonly string[];
  readonly routeEvent: EventRouter;
  readonly encodeInput: (text: string) => string;
  readonly redispatchPrompt: (input: RedispatchInput) => string;
}
