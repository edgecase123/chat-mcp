import { homedir } from "node:os";
import { join } from "node:path";
import type { SpawnOptions } from "../child.js";
import type { RateLimitSnapshot } from "../rate-limit.js";
import type { Denial } from "../denial.js";
import type { ContextSnapshot } from "../context-gauge.js";
import type { RedispatchInput } from "./claude-redispatch.js";

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
 * The model a supervised `cursor-agent` runs when nothing names one.
 *
 * 🛑 lee's RULING OF 2026-11-21 (#371): *"pin model for cursor agent, default
 * is the native cursor fast model."* Pinning costs Cursor's own per-request
 * routing, and that was the trade he accepted.
 *
 * 🛑 PINNING THIS BUYS NO CONTEXT GAUGE, AND THAT WAS THE HOPE BEHIND THE
 * RULING. A denominator needs the window size, and `--list-models` names one
 * only in the ids that carry it — `Claude Opus 5 1M Thinking` does, and
 * `Composer 2.5 Fast` does not. So `cursorSpawn.reportsContext` stays `false`
 * and #371's fix is the card saying so, not this constant.
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

  // ⚠️ ALWAYS PASSED, NEVER CONDITIONAL. Omitting the flag leaves the CLI on
  // `auto`, which is the state lee's ruling removes.
  args.push("--model", opts.model || CURSOR_DEFAULT_MODEL);
  if (opts.resumeSessionId) {
    args.push(...cursorResumeFlags(opts.resumeSessionId));
  }

  return args;
}

/**
 * Map one `cursor-agent` stream-json event onto the semantic callbacks.
 *
 * 🛑 THE TERMINAL EVENT IS `{"type":"result"}`, THE SAME SPELLING CLAUDE CODE
 * USES, AND THAT IS A COINCIDENCE RATHER THAN A CONTRACT. Measured on #317.
 * Sharing a spelling is what makes a shape-sniffing bug above the driver
 * invisible: such a bug would pass for both vendors and only surface on a
 * third. Each driver still owns its own mapping for that reason.
 *
 * ⚠️ NEITHER THE `usage` NOR THE `context` SINK IS CALLED, and
 * `cursorSpawn` declares both `false` to match. See the note on
 * `reportsUsage` in `cursorSpawn`.
 */
export function routeCursorEvent(
  event: Record<string, unknown>,
  on: {
    turnEnd(): void;
    usage(snapshot: RateLimitSnapshot): void;
    context?(snapshot: ContextSnapshot): void;
    denial?(denial: Denial): void;
    session?(id: string): void;
    toolCall?(name: string | null): void;
  },
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

  if (event.type === "result") on.turnEnd();

  // 🛑 A TOP-LEVEL EVENT, NOT A BLOCK INSIDE AN `assistant` MESSAGE. The
  // silent-reply detector used to read `tool_use` blocks itself and returned
  // at its first line for anything that was not `type: "assistant"` — so
  // every Cursor turn that sent was reported as having answered nobody, and
  // a real silent reply became indistinguishable from the false alarm. #392.
  if (event.type === "tool_call" && on.toolCall) {
    on.toolCall(cursorToolName(event.tool_call));
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
 */
function cursorToolName(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;

  const variants = Object.keys(raw).filter((k) => k.endsWith("ToolCall"));

  // Zero is an unrecognised shape. More than one is ambiguous, and picking
  // either would be a guess about which tool actually ran.
  if (variants.length !== 1) return null;

  const key = variants[0];

  if (key === "mcpToolCall") {
    const name = (raw as Record<string, { toolName?: unknown }>)[key]?.toolName;

    return typeof name === "string" && name ? name : null;
  }

  return key;
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
