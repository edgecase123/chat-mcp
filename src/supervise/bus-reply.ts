/**
 * Permission for a supervised agent to answer on the bus.
 *
 * 🛑 SEMANTIC, SO A SECOND DRIVER CAN EXPRESS IT ITS OWN WAY. Claude Code
 * needs four argv flags and a generated MCP config file. Another CLI may need
 * neither. Nothing above the driver should know which.
 *
 * ⚠️ It is a SINGLE decision, not a bag of flags. Measured on chat-mcp#33:
 * `--mcp-config` without `--strict-mcp-config` leaves the child reading the
 * project's `.mcp.json`, which hardcodes a handle a live session already owns.
 * Half of this configuration is worse than none of it.
 */
export interface BusReply {
  /**
   * The handle the CHILD registers under.
   *
   * Never the supervisor's own. A child sharing the supervisor's handle
   * consumes the very messages the supervisor is delivering to it — `inbox`
   * marks messages read, so the loser of that race sees an empty array.
   */
  readonly handle: string;

  /** Where the driver wrote the child's private MCP config. */
  readonly configPath: string;

  /** The only tools the child may use. Everything else is denied. */
  readonly tools: readonly string[];
}

/**
 * The least privilege that still allows an answer: a DM and a room post.
 *
 * 🛑 NOT A WIDER PERMISSION MODE, WHICH WAS THE ONLY OPTION THE TICKET
 * OFFERED. With no built-in tools at all the child has no Bash, no Edit, no
 * Read and no Web. It can say something on the bus and nothing else.
 *
 * ⚠️ `mcp__chat__send` is proven end to end on chat-mcp#33. `room_send` is the
 * identical code path and is NOT separately proven.
 */
export const DEFAULT_REPLY_TOOLS = ['mcp__chat__send', 'mcp__chat__room_send'] as const;

/**
 * The handle a supervised child registers under, derived from the supervisor's.
 *
 * Derived rather than configured so the two can never be made equal by
 * forgetting a flag.
 */
export function childHandleFor(supervisorHandle: string): string {
  return `${supervisorHandle}-agent`;
}
