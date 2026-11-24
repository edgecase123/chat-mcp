import { homedir } from "node:os";
import { join } from "node:path";
import type { SpawnOptions } from "../child.js";
import type { RateLimitSnapshot } from "../rate-limit.js";
import type { Denial } from "../denial.js";
import type { ContextSnapshot } from "../context-gauge.js";
import type { RouterState } from "../vendor.js";
import type { RedispatchInput } from "./claude-redispatch.js";
import type { UnnamedToolCall } from "../child.js";

/** `cursorToolName`'s answer: a name, or the reason there is none. */
type NamedToolCall =
  { name: string; why?: undefined } | { name: null; why: UnnamedToolCall };

/**
 * The Cursor CLI driver: the ONLY file that knows `cursor-agent`'s flags and
 * event shapes.
 *
 * Every flag below was measured against the live binary on #317 rather than
 * read off its help text. The two that cost the most are `--trust` and
 * `--approve-mcps`, because both fail by producing a clean exit with no
 * events, which reads as "the agent had nothing to say".
 */

/**
 * `cursor-agent` is NOT on `PATH`, so the binary must be named absolutely.
 *
 * ⚠️ ITS INSTALLER IS `curl https://cursor.com/install | bash`, NOT npm, and
 * it writes here. A bare `cursor-agent` exits 127 and the supervisor reports a
 * dead agent rather than a missing CLI.
 */
export const CURSOR_HOST_BINARY: string = join(
  homedir(),
  ".local",
  "bin",
  "cursor-agent",
);

/**
 * Where the Cursor image installs `cursor-agent`, as `VendorSpawn.containerBinary`.
 *
 * 🛑 THE DOCKERFILE IS THE SOURCE, AND THIS VALUE ONCE DISAGREED WITH IT. It
 * said `/root/.local/bin/cursor-agent`, copying the host layout, and that
 * directory does not exist in the image — the install unpacks to
 * `/opt/cursor-agent` and symlinks here. `container-binary.test.ts` now reads
 * the `ln -s` target out of the `cli-cursor` lineage, so the two cannot drift
 * again.
 *
 * ⚠️ NOT COMPARED TO `CURSOR_CONTAINER_HOME`. The guard this replaced asserted
 * that it sits under that constant, a coupling the image does not have. Two
 * constants checked against each other, wrong together, passing.
 */
export const CURSOR_CONTAINER_BINARY = "/usr/local/bin/cursor-agent";

/** The container's `HOME`. The bus resolves its state dir from it. */
export const CURSOR_CONTAINER_HOME = "/root";

/**
 * Build the argv for a supervised `cursor-agent` child.
 *
 * ⚠️ `--trust` IS NOT OPTIONAL. Without it the process exits 1 with
 * `Workspace Trust Required` and emits ZERO events, so the supervisor sees a
 * turn that never ended rather than a refusal it can report.
 *
 * ⚠️ `--approve-mcps` IS A SECOND FLAG BESIDE `--force`. `--force` alone
 * enables tools and still leaves the bus servers unapproved, which is the same
 * silent-denial shape that cost a week on Claude Code's two permission flags.
 */
/**
 * The flags that continue an existing `cursor-agent` session.
 *
 * 🛑 ONE SPELLING, ASKABLE BY THE RELAY. The turn relay appends these itself
 * for every turn after the first, so a second copy inside `cursorArgs` is a
 * spelling that can drift from the one the relay passes.
 */
export function cursorResumeFlags(sessionId: string): readonly string[] {
  return ["--resume", sessionId];
}

/**
 * The model a supervised `cursor-agent` runs when no caller names one.
 *
 * 🛑 lee's RULING OF 2026-11-23: *"The default for cursor is Composer 2.5 Fast
 * and that is what we'll use as the default."* That SUPERSEDES his ruling of
 * 2026-11-22, *"keep it on auto for now."* #419.
 *
 * 🛑 USE THE DISTINCT ID, NEVER THE BASE MODEL PLUS A `fast` PARAMETER. The
 * other route to this model is `composer-2.5` with `modelParameters` in
 * `~/.cursor/cli-config.json`, which is HOST STATE A CONTAINER WILL NOT HAVE.
 * 🛑 DERIVED, NOT MEASURED. No run from an absent config was ever made, so
 * neither "the flag alone resolves" nor the `init` string is observed. Every
 * measurement to date ran on a host that already had a stored model.
 *
 * ⚠️ IT STILL WRITES. `composer-2.5-fast` NORMALISES INTO THE STORE AS
 * `composer-2.5` PLUS `fast: true`, so it is a no-op only from a store that
 * already holds that pair. An earlier cut of this note claimed it left the
 * file byte-identical — that was ONE measurement, from exactly that state,
 * read as a property.
 *
 * 🛑 THE TABLE BELOW IS CONTRADICTED BY MEASUREMENT, AND NO CAUSE IS
 * ESTABLISHED. Row 1 has `composer-2.5-fast` exiting 1; a 4-turn resume chain
 * on 2026-11-23 exits 0 every turn. **Why row 1 exited 1 is UNKNOWN.** An
 * earlier cut of this note argued its `stored after` of `composer-2.5` was the
 * tell of a contaminated run — the normalisation above makes that the CORRECT
 * stored value for the id passed, so the argument was void. **The table is
 * kept as history, not as current behaviour.**
 *
 * 🛑 OMITTING `--model` DOES NOT MEAN A SAFE DEFAULT. It means WHATEVER MODEL WAS LAST
 * SELECTED ON THIS HOST. `cursor-agent --model X` PERSISTS X into
 * `~/.cursor/cli-config.json`, and it persists it even when the turn FAILS — so
 * one operator trying a model their plan rejects leaves every later unattended
 * agent on it. Measured against the live binary, argv built by `cursorArgs()`,
 * reading the stored value between runs:
 *
 * | stored before | `--model`           | exit | stored after   |
 * |---------------|---------------------|------|----------------|
 * | `auto`        | `composer-2.5-fast` | 1    | `composer-2.5` |
 * | `composer-2.5`| none                | 1    | `composer-2.5` |
 * | `composer-2.5`| `auto`              | 0    | `auto`         |
 *
 * ⚠️ THE SECOND ROW IS WHY A NO-FLAG RUN IS NOT REPRODUCIBLE. It inherits the
 * row above it. An earlier measurement of mine read that inheritance as "the
 * CLI's default is Composer" — it was my own previous command. claude1's
 * counter-measurement on #371 is what exposed it.
 *
 * 🛑 PINNING THIS MODEL IS WHAT MAKES A CONTEXT GAUGE POSSIBLE, and the
 * previous note here said the opposite. It concluded from `--list-models`
 * naming no window for `Composer 2.5 Fast` that no denominator existed. **A
 * window does not have to arrive in the stream — it is a constant per model,
 * and the stream only has to name which model ran.** An `auto` handle reports
 * its model as the literal `"Auto"`, which names nothing; a pinned one reports
 * a display name the driver can map. #419.
 */
export const CURSOR_DEFAULT_MODEL = "composer-2.5-fast";

export function cursorArgs(opts: SpawnOptions = {}): string[] {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--trust",
    // 🛑 `--yolo` IS AN ALIAS OF `--force`, NOT A SEPARATE ENABLER. There is no
    // activator/enabler split here, unlike Claude Code's two flags.
    "--force",
    "--approve-mcps",
  ];

  // ⚠️ ALWAYS PASSED, NEVER CONDITIONAL. Omitting it is NOT `auto` — see
  // `CURSOR_DEFAULT_MODEL`, where the exit codes are.
  args.push("--model", opts.model || CURSOR_DEFAULT_MODEL);
  if (opts.resumeSessionId) {
    args.push(...cursorResumeFlags(opts.resumeSessionId));
  }

  return args;
}

/**
 * Context-window size per Cursor model, or null when the model is not mapped.
 *
 * 🛑 KEYED ON THE DISPLAY NAME, NOT THE `--model` ID. `system init` reports
 * `model: "Composer 2.5 Fast"`; the id passed on the command line is
 * `composer-2.5-fast`. A map keyed on the id matches nothing, every reading
 * falls back, and nothing says so louder than one quiet boolean.
 *
 * 🛑 CURSOR'S OWN MAP, NOT `claude-events.ts`'s. Those keys are Claude model
 * ids, and sharing the table would let one vendor's knowledge decide another
 * vendor's denominator.
 *
 * ⚠️ 200K IS READ FROM THE CURSOR IDE'S `/context`, NOT FROM `cursor-agent`.
 * Whether the CLI uses the same window is unproven. #419.
 */
export const CURSOR_CONTEXT_WINDOWS: Readonly<Record<string, number>> = {
  "Composer 2.5 Fast": 200_000,
};

/**
 * The smallest window in a map, which is what an unmapped model measures
 * against.
 *
 * 🛑 TOO-SMALL IS THE SAFE DIRECTION, the same rule `claude-events.ts` states:
 * a denominator that is too large reads LOW, so no band fires and the gauge
 * goes quiet exactly when the agent is full. Too-small reads high and warns
 * early.
 *
 * 🛑 A FUNCTION OVER A PASSED MAP, NOT A `Math.min` OVER THE CONST. Over a
 * one-entry map `Math.min` and `Math.max` return the same number, so a control
 * against the const could not tell a correct derivation from a reversed one —
 * and a module const gives a test no way to inject a second entry. Taking a
 * map as an argument pins the direction today instead of promising it at the
 * second model. Raised by claude1 reviewing the plan.
 */
export function smallestWindow(
  windows: Readonly<Record<string, number>>,
): number {
  const sizes = Object.values(windows);

  if (sizes.length === 0) {
    throw new Error("smallestWindow needs at least one mapped window");
  }

  return Math.min(...sizes);
}

/** The window an unmapped Cursor model is measured against. */
export const CURSOR_FALLBACK_CONTEXT_WINDOW: number = smallestWindow(
  CURSOR_CONTEXT_WINDOWS,
);

/**
 * One mapped window, or undefined.
 *
 * 🛑 `Object.hasOwn`, NEVER `windows[name] ?? fallback`. An inherited member is
 * not nullish, so a model reported as `"toString"` answered with a FUNCTION
 * where the signature promises a number — `totalIsFallback` came back false,
 * nothing logged, and the percentage was NaN. Measured on the Claude side and
 * carried here deliberately.
 */
function mappedCursorWindow(name: string): number | undefined {
  return Object.hasOwn(CURSOR_CONTEXT_WINDOWS, name)
    ? CURSOR_CONTEXT_WINDOWS[name]
    : undefined;
}

/**
 * The tokens a Cursor turn is holding, out of a `result` event's usage.
 *
 * 🛑 THE SUM, NEVER `inputTokens` ALONE. On a resumed turn the earlier context
 * moves into the cache, so `inputTokens` FALLS while the real fill RISES —
 * measured at 13764 then 2490 over a context that grew. A gauge built on
 * `inputTokens` runs backwards and goes quiet as the agent fills.
 *
 * ⚠️ `cacheWriteTokens` AND `reasoningTokens` ARE LEFT OUT, and that is not
 * settled. Both were 0 or absent in every measured turn, so neither has been
 * observed to matter. #419.
 */
function cursorUsedTokens(usage: Record<string, unknown>): number | null {
  const input = usage.inputTokens;
  const cached = usage.cacheReadTokens;

  if (typeof input !== "number") return null;

  return input + (typeof cached === "number" ? cached : 0);
}

/**
 * The context reading a `result` event carries, or null if it carries none.
 *
 * 🛑 THE MODEL COMES OUT OF THE BAG, BECAUSE IT IS ON A DIFFERENT EVENT.
 * `system init` names the model and `result` carries the counts, and
 * `routeCursorEvent` is otherwise stateless. `claude-events.ts` records that
 * remembered-`init` state was tried twice on the Claude side and rejected —
 * there a mid-session model change emits no new `init` and leaves a
 * confidently wrong percentage. Cursor is not subject to that: `processPerTurn`
 * is true, so every turn is its own process and re-emits its own `init`.
 *
 * 🛑 A TURN WITH NO `init` MUST NOT INHERIT THE PREVIOUS TURN'S MODEL. That is
 * what the caller's clear is for, and it is why this reads `state.model`
 * rather than a module slot.
 */
export function cursorContextSnapshot(
  event: Record<string, unknown>,
  model: string | null,
): ContextSnapshot | null {
  const usage = event.usage;

  if (!usage || typeof usage !== "object") return null;

  const used = cursorUsedTokens(usage as Record<string, unknown>);

  if (used === null) return null;

  const mapped = model === null ? undefined : mappedCursorWindow(model);

  return {
    used,
    total: mapped ?? CURSOR_FALLBACK_CONTEXT_WINDOW,
    model,
    totalIsFallback: mapped === undefined,
  };
}

/**
 * Where `routeCursorEvent` keeps the model between `init` and `result`.
 *
 * 🛑 ONE SPELLING, IN ONE PLACE. The key is written on one event and read on
 * another, so two literals could drift and the reader would silently find
 * `undefined` — which resolves to a fallback rather than to an error.
 */
const MODEL_KEY = "cursorModel";

/**
 * Map one `cursor-agent` stream-json event onto the semantic callbacks.
 *
 * 🛑 THE TERMINAL EVENT IS `{"type":"result"}`, THE SAME SPELLING CLAUDE CODE
 * USES, AND THAT IS A COINCIDENCE RATHER THAN A CONTRACT. Measured on #317.
 * Sharing a spelling is what makes a shape-sniffing bug above the driver
 * invisible: such a bug would pass for both vendors and only surface on a
 * third. Each driver still owns its own mapping for that reason.
 *
 * ⚠️ THE `usage` SINK IS NEVER CALLED, and `cursorSpawn` declares
 * `reportsUsage: false` to match. Token counts are not a `RateLimitSnapshot`.
 *
 * 🛑 THE `context` SINK IS CALLED ON `result`, and an earlier cut of this note
 * said a Cursor gauge was impossible. Its reasoning was that no window TOTAL
 * appears in the stream. A window is a constant per model, so the stream only
 * has to name WHICH model ran — and `system init` does. #419.
 */
export function routeCursorEvent(
  event: Record<string, unknown>,
  on: {
    turnEnd(): void;
    usage(snapshot: RateLimitSnapshot): void;
    context?(snapshot: ContextSnapshot): void;
    denial?(denial: Denial): void;
    session?(id: string): void;
    toolCall?(name: string | null, why?: UnnamedToolCall): void;
  },
  state: RouterState,
): void {
  // 🛑 THE ID ARRIVES ON THE INIT EVENT, WHICH IS THE FIRST LINE OF THE
  // STREAM. Measured against cursor-agent 2026.11.19-f005e9d:
  // `{"type":"system","subtype":"init",...,"session_id":"..."}` precedes the
  // prompt echo, and every later event repeats the same id.
  //
  // 🛑 SO A RESUMABLE GRANT IS KNOWN BEFORE THE FIRST TURN ENDS, and
  // narrowing this to `type === "result"` would defer it by a whole turn —
  // losing the id entirely for a turn that crashes. An earlier cut of this
  // comment claimed the opposite and no test could tell. Pinned by the
  // non-terminal case in `cursor-vendor.test.ts`.
  const id = event.session_id;

  if (typeof id === "string" && on.session) on.session(id);

  // 🛑 WRITTEN ON `init` AND READ ON `result`. Those are two events, and this
  // function is called once per event with no memory of its own. The bag is
  // the only thing that spans them. #419.
  if (event.type === "system" && event.subtype === "init") {
    const model = event.model;

    state[MODEL_KEY] =
      typeof model === "string" && model.length > 0 ? model : null;
  }

  if (event.type === "result") {
    const held = state[MODEL_KEY];
    const model = typeof held === "string" ? held : null;

    // 🛑 CLEARED BEFORE THE TURN ENDS, NOT AFTER. The bag outlives a turn —
    // `per-turn.ts` holds one fan-out across every process — so a turn that
    // emits a `result` with no preceding `init` would otherwise inherit the
    // previous turn's model and report a guess as measured.
    delete state[MODEL_KEY];

    const snapshot = cursorContextSnapshot(event, model);

    if (snapshot && on.context) on.context(snapshot);

    on.turnEnd();
  }

  // 🛑 A TOP-LEVEL EVENT, NOT A BLOCK INSIDE AN `assistant` MESSAGE. The
  // silent-reply detector used to read `tool_use` blocks itself and returned
  // at its first line for anything that was not `type: "assistant"` — so
  // every Cursor turn that sent was reported as having answered nobody, and
  // a real silent reply became indistinguishable from the false alarm. #392.
  if (event.type === "tool_call" && on.toolCall) {
    const named = cursorToolName(event.tool_call);

    on.toolCall(named.name, named.why);
  }
}

/**
 * The tool's own name out of a Cursor `tool_call` event, or `null`.
 *
 * 🛑 THE VARIANT KEY IS THE NAME, AND IT NEEDS NO KNOWLEDGE OF THE INSIDE.
 * `tool_call` is a oneof whose variants are each `*_tool_call`; 49 distinct
 * camelCase `*ToolCall` keys appear in the bundle at 2026.11.19-f005e9d. So
 * exactly one such key identifies the call even when its contents surprise us.
 *
 * 🛑 A `kind` FALLBACK WAS TRIED AND IT DEFEATED THE WHOLE GUARD. Every
 * sampled `toolCall` object carries one, so an unrecognised shape was named
 * `"other"` — not null, no signal — and a bus `send` under a wrong path
 * produced the same false warning as #392 with nothing reporting it.
 * claude1 on PR 393.
 *
 * ⚠️ AN MCP CALL WE CANNOT NAME REPORTS `null`, NOT ITS KEY. `mcpToolCall` is
 * the only variant a bus `send` arrives under, so naming it `"mcpToolCall"`
 * would assert "a tool ran and it was not a send" — the one claim this
 * function must never make on a guess.
 *
 * 🛑 THE `why` IS LOAD-BEARING, NOT DIAGNOSTIC. Only `unnamed-mcp` can
 * have swallowed a send, so it is the only cause that may soften the
 * silent-reply warning. #417.
 */
function cursorToolName(raw: unknown): NamedToolCall {
  if (!raw || typeof raw !== "object")
    return { name: null, why: "unknown-shape" };

  const variants = Object.keys(raw).filter((k) => k.endsWith("ToolCall"));

  // Zero is an unrecognised shape. More than one is ambiguous, and picking
  // either would be a guess about which tool actually ran.
  if (variants.length === 0) return { name: null, why: "unknown-shape" };
  if (variants.length > 1) return { name: null, why: "ambiguous" };

  const key = variants[0];

  if (key === "mcpToolCall") {
    const name = (raw as Record<string, { toolName?: unknown }>)[key]?.toolName;

    return typeof name === "string" && name
      ? { name }
      : { name: null, why: "unnamed-mcp" };
  }

  return { name: key };
}

/**
 * `cursor-agent -p` reads its prompt from stdin to EOF, so the text IS the
 * payload.
 *
 * 🛑 NO JSON ENVELOPE AND NO TRAILING NEWLINE ADDED. Claude Code's encoder
 * wraps each prompt in a `{"type":"user"}` line because its stdin is a
 * stream-json stream of many messages. Wrapping here would send the agent the
 * literal JSON as its question.
 */
export function cursorEncodeInput(text: string): string {
  return text;
}

/**
 * The three things Cursor's re-dispatch prompt must say.
 *
 * 🛑 ITS OWN CLAUSES, BECAUSE THE CLAUDE ONE NAMES `--allowedTools`. That is
 * Claude Code's flag and Cursor has no such thing; its tool gate is `--force`,
 * which is already passed on every spawn.
 *
 * ⚠️ THE 3-OF-3 EVIDENCE BEHIND THE CLAUDE WORDING IS ABOUT CLAUDE CODE ONLY.
 * These clauses mirror its STRUCTURE — new invocation, what changed, the old
 * denial is dead — because that structure is what stopped the refusals. **No
 * live Cursor re-dispatch has been measured.** Treat the wording as unproven.
 */
export const CURSOR_REQUIRED_CLAUSES: readonly {
  readonly name: string;
  readonly pattern: RegExp;
}[] = [
  { name: "new-invocation", pattern: /This is a NEW invocation\./ },
  { name: "now-permitted", pattern: /is now permitted for this session/ },
  {
    name: "denial-superseded",
    pattern: /the earlier denial no longer applies/,
  },
];

/** Which required clauses a Cursor re-dispatch prompt is missing. */
export function cursorMissingClauses(prompt: string): string[] {
  return CURSOR_REQUIRED_CLAUSES.filter((c) => !c.pattern.test(prompt)).map(
    (c) => c.name,
  );
}

export function cursorRedispatchPrompt(input: RedispatchInput): string {
  const command = input.grantedCommand.trim();

  // 🛑 An empty command would produce a prompt that passes every clause check
  // and tells the agent nothing. Fail loudly instead, as the Claude one does.
  if (command.length === 0) {
    throw new Error(
      "cursorRedispatchPrompt needs the granted command, verbatim",
    );
  }

  const prompt = [
    "This is a NEW invocation.",
    `The command \`${command}\` is now permitted for this session,`,
    "so the earlier denial no longer applies.",
    `Please attempt \`${command}\` now and report what the tool returns.`,
    input.followUp.trim(),
  ]
    .filter((line) => line.length > 0)
    .join(" ");

  // 🛑 The guard runs on the way out, so a future edit cannot quietly drop a
  // clause.
  const missing = cursorMissingClauses(prompt);

  if (missing.length > 0) {
    throw new Error(
      `cursorRedispatchPrompt lost required clause(s): ${missing.join(", ")}`,
    );
  }

  return prompt;
}
