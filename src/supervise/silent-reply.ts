/**
 * Did this turn answer somebody, or only answer?
 *
 * 🛑 THE DEFECT IS THE INVERSE OF #209's. That one made "the agent said
 * nothing" visible. This one is the agent producing prose and calling no
 * `send`, so the peer receives nothing while both transcripts read as
 * answered.
 *
 * ⚠️ IT READS NEITHER A CALL'S INPUT NOR ITS RESULT, so `sent` means the
 * child ATTEMPTED a send, never that one landed.
 * `drivers/claude-events.ts` forbids capturing the input — a
 * `mcp__chat__send` input IS the message body. Ruled by lee 2026-11-16: flag
 * a turn with no send at all.
 *
 * 🛑 SO A REFUSED SEND CLEARS THE WARNING. `shim/tools/send.ts` throws before
 * `insertMessage` on an over-cap body, a send to self, a `#room` target and an
 * unknown peer. Pinned by a test, so closing the gap turns that test red.
 *
 * 🛑 THERE ARE THREE OUTCOMES, NOT TWO. A call the driver could not name
 * may have BEEN the send, so this file reports UNKNOWN rather than choosing
 * between hiding the warning and blaming the agent. #417.
 */

import type { UnnamedToolCall } from "./child.js";

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
  /**
   * A call that COULD have been a send arrived unnameable.
   *
   * 🛑 SCOPED TO `unnamed-mcp`. An unknown or ambiguous SHAPE is as likely
   * a file read, and softening the warning for those would hide a real lost
   * reply — #392 inverted. Only `mcpToolCall` carries a bus send.
   */
  unnamed: boolean;
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
  return { owed, said: false, sent: false, unnamed: false };
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
 * 🛑 TEXT ONLY. Tool calls arrive through `observeToolCall`, named by the
 * driver, because their SHAPE is a vendor's business and sniffing for one
 * here went blind the moment a second vendor existed. #392.
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
    const b = block as { type?: unknown; text?: unknown };

    if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
      turn.said = true;
    }
  }
}

/**
 * Fold one tool call into the turn, named or not.
 *
 * 🛑 THE DRIVER NAMES IT; THIS FILE NEVER SNIFFS FOR IT. `observe` above used
 * to read Claude Code's `tool_use` blocks directly, which made it blind to
 * any vendor using another shape — Cursor emits a TOP-LEVEL `tool_call`
 * event, so every Cursor turn that sent was reported as having answered
 * nobody, and a real silent reply became indistinguishable. #392.
 *
 * 🛑 A `null` NAME IS A THIRD STATE, NOT ONE OF THE OTHER TWO. The header's
 * old dilemma — call it a send and hide the warning, or call it absent and
 * hide the driver being wrong — was a false one. This records that the
 * supervisor CANNOT KNOW, and `silentReplyWarning` then says so. #417.
 */
export function observeToolCall(
  turn: TurnOutbound,
  name: string | null,
  why?: UnnamedToolCall,
): void {
  if (name === null) {
    if (why === "unnamed-mcp") turn.unnamed = true;

    return;
  }

  if (isOutboundChatTool(name)) turn.sent = true;
}

/**
 * One log line for a turn that answered nobody, or `undefined`.
 *
 * 🛑 A TURN THAT SAID NOTHING IS NOT THIS DEFECT. Warning on it would fire on
 * every tool-only turn the supervisor runs, which is most of them.
 */
export function silentReplyWarning(turn: TurnOutbound): string | undefined {
  if (!turn.owed || !turn.said || turn.sent) return undefined;

  // 🛑 WITHHOLD THE DELIVERY CLAIM, DO NOT INVERT IT. A send may have ridden
  // the call the driver could not name, so neither "nobody received it" nor
  // silence is true. #417.
  if (turn.unnamed) {
    return (
      "this turn produced a reply and called a tool this driver could not " +
      "name, so whether anybody received it is UNKNOWN"
    );
  }

  return (
    "this turn produced a reply and called no send or room_send, " +
    "so nobody received it"
  );
}
