/**
 * The semantic shape of "the child was refused a tool".
 *
 * 🛑 THE TYPE IS HERE; THE WORDING IS IN THE DRIVER. Claude Code reports a
 * denial as a `tool_result` opening with a fixed English sentence. Another CLI
 * will not. `drivers/claude-events.ts` owns that string, so a Cursor driver
 * maps its own signal onto this type and nothing above the driver changes.
 *
 * Moved out of this file on lee's instruction, 2026-10-31.
 */
export interface Denial {
  /**
   * What needed approval, or null when it could not be parsed.
   *
   * 🛑 NULL, NEVER A GUESS. This string is what gets relayed to lee and then
   * allowlisted, so a guess would ask lee to approve something the child never
   * asked for.
   */
  readonly requested: string | null;

  /** The whole message, so a relay can quote the reason instead of summarising. */
  readonly raw: string;

  /**
   * The tool that was refused, e.g. `Bash`.
   *
   * 🛑 FROM THE TOOL CALL, NOT THE PROSE. `requested` is what a human reads;
   * this is what the allowlist needs. They are different languages, and
   * feeding the prose into `--allowedTools` grants nothing — measured live:
   * lee approved `rm in '/path/README.md'`, the child was denied again, and
   * a second card appeared.
   */
  readonly tool: string | null;

  /** The exact invocation, e.g. the full Bash command line. */
  readonly invocation: string | null;
}

/**
 * The allowlist entry that grants exactly this invocation and nothing else.
 *
 * 🛑 EXACT, NOT A PREFIX — lee's decision, 2026-10-31. `Bash(rm:*)` would
 * grant every `rm` for the rest of the session, which is broader than the
 * card said. Measured: an exact entry is honoured, with a control proving
 * the allowlist is what decided.
 */
export function grantFor(denial: Denial): string | null {
  if (!denial.tool || !denial.invocation) return null;

  return `${denial.tool}(${denial.invocation})`;
}
