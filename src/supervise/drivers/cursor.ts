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
 * Where unit 3's Cursor image must install the same binary.
 *
 * 🛑 `VendorSpawn.binary` IS ONE STRING FOR BOTH SANDBOX MODES, so the host
 * path and the container path cannot both be it. The host path wins today
 * because the host spawn is what unit 2 ships. **Unit 3 must either install
 * the CLI at this exact path and make `binary` mode-aware, or reconcile the
 * two — it cannot assume the host value works inside the image**, because
 * `homedir()` on the host is not `/root`.
 */
export const CURSOR_CONTAINER_BINARY = "/root/.local/bin/cursor-agent";

/** The container's `HOME`, which `CURSOR_CONTAINER_BINARY` sits under. */
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

  if (opts.model) args.push("--model", opts.model);
  if (opts.resumeSessionId) args.push("--resume", opts.resumeSessionId);

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
  },
): void {
  // The session id rides the terminal event, not an init event, so a resumable
  // grant is only known once the first turn has finished.
  const id = event.session_id;

  if (typeof id === "string" && on.session) on.session(id);

  if (event.type === "result") on.turnEnd();
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
