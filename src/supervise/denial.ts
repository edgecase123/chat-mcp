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
}
