/**
 * Did this turn answer somebody, or only answer?
 *
 * 🛑 THE DEFECT IS THE INVERSE OF #209's. That one made "the agent said
 * nothing" visible. This one is the agent producing prose and calling no
 * `send`, so the peer receives nothing while both transcripts read as
 * answered.
 *
 * ⚠️ IT NEVER READS A TOOL CALL'S INPUT, so it cannot tell who a send
 * reached and does not try. `drivers/claude-events.ts` forbids capturing that
 * input — a `mcp__chat__send` input IS the message body. Ruled by lee
 * 2026-11-16: flag a turn with no send at all.
 */

/** The bus tools that put a message in front of somebody else. */
const OUTBOUND = new Set(["send", "room_send"]);

const CHAT_PREFIX = "mcp__chat__";

export interface TurnOutbound {
  /** A peer is waiting: this turn was prompted by inbound bus messages. */
  owed: boolean;
  /** The child produced at least one non-blank text block. */
  said: boolean;
  /** The child called an outbound bus tool. */
  sent: boolean;
}

/**
 * 🛑 `owed` IS WHAT STOPS THIS BEING NOISE. "Prose and no send" is an ordinary
 * turn when the supervisor prompted its own child — a grant notice, a model
 * replacement — because nobody is waiting on those.
 *
 * `index.ts` builds `messageIds: [envelope.id]` for an inbound bus message and
 * `messageIds: []` for every internal prompt, so a non-empty id list IS the
 * question "was a reply owed".
 */
export function newTurn(owed: boolean): TurnOutbound {
  return { owed, said: false, sent: false };
}

/**
 * ⚠️ AN UNPREFIXED NAME IS ACCEPTED ON PURPOSE. The `mcp__chat__` prefix is
 * the MCP client's, not the bus's, and a driver reporting a bare name would
 * otherwise make this detector silently blind rather than loud.
 *
 * 🛑 A DIFFERENT SERVER'S `send` IS NOT THIS BUS. `mcp__other__send` must not
 * clear the warning, so a prefixed name is accepted only under this server.
 */
export function isOutboundChatTool(name: string): boolean {
  if (name.startsWith("mcp__")) {
    return (
      name.startsWith(CHAT_PREFIX) &&
      OUTBOUND.has(name.slice(CHAT_PREFIX.length))
    );
  }

  return OUTBOUND.has(name);
}

/**
 * Fold one child event into the turn.
 *
 * ⚠️ ORDER CANNOT MATTER. An agent that sends before writing its closing
 * prose is the common shape, so both flags only ever move to `true`.
 */
export function observe(
  turn: TurnOutbound,
  event: Record<string, unknown>,
): void {
  if (event.type !== "assistant") return;

  const message = event.message as { content?: unknown } | undefined;
  const content = message?.content;

  if (!Array.isArray(content)) return;

  for (const block of content) {
    const b = block as { type?: unknown; text?: unknown; name?: unknown };

    if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
      turn.said = true;
    } else if (
      b.type === "tool_use" &&
      typeof b.name === "string" &&
      isOutboundChatTool(b.name)
    ) {
      turn.sent = true;
    }
  }
}

/**
 * One log line for a turn that answered nobody, or `undefined`.
 *
 * 🛑 A TURN THAT SAID NOTHING IS NOT THIS DEFECT. Warning on it would fire on
 * every tool-only turn the supervisor runs, which is most of them.
 */
export function silentReplyWarning(turn: TurnOutbound): string | undefined {
  if (!turn.owed || !turn.said || turn.sent) return undefined;

  return (
    "this turn produced a reply and called no send or room_send, " +
    "so nobody received it"
  );
}
