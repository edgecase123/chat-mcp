import type { SpawnOptions } from "./child.js";
import type { ChildGrant } from "./grant.js";
import type { Denial } from "./denial.js";
import type { RateLimitSnapshot } from "./rate-limit.js";
import type { ContextSnapshot } from "./context-gauge.js";
import type { RedispatchInput } from "./drivers/claude-redispatch.js";

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
  readonly binary: string;
  readonly image: string;
  /**
   * The container's `HOME`. The bus resolves its state dir from it, so an
   * image whose HOME differs from this value loses the bus silently.
   */
  readonly containerHome: string;
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
  readonly routeEvent: EventRouter;
  readonly encodeInput: (text: string) => string;
  readonly redispatchPrompt: (input: RedispatchInput) => string;
}
