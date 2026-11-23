import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isOutboundChatTool,
  newTurn,
  observe,
  silentReplyWarning,
  observeToolCall,
} from "../../src/supervise/silent-reply.js";
import type { UnnamedToolCall } from "../../src/supervise/child.js";

/**
 * 🛑 THE DEFECT: A TURN THAT ANSWERED NOBODY LOGGED LIKE ONE THAT ANSWERED.
 *
 * #209 wired the child's event feed to the supervisor's log, so "said nothing"
 * became visible. This is the inverse — the agent produced prose and never
 * called `send`, so the peer got nothing while both transcripts read as
 * answered.
 *
 * ⚠️ RULED BY lee 2026-11-16: "no send at all". The detector reads neither a
 * call's INPUT nor its RESULT, so `sent` means ATTEMPTED, not delivered.
 * `drivers/claude-events.ts` forbids capturing that input — a send's input IS
 * the message body. The refused-send gap that follows from it is pinned below.
 */

function assistantText(text: string): Record<string, unknown> {
  return { type: "assistant", message: { content: [{ type: "text", text }] } };
}

function assistantTool(name: string): Record<string, unknown> {
  return {
    type: "assistant",
    message: { content: [{ type: "tool_use", name }] },
  };
}

/** The shape `denialFromClaude` in `drivers/claude-events.ts` reads a tool
 * failure out of. */
function toolFailed(text: string): Record<string, unknown> {
  return {
    type: "user",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_01",
          content: text,
          is_error: true,
        },
      ],
    },
  };
}

test("a turn that produced prose and called no send is warned about", () => {
  const turn = newTurn(true);

  observe(turn, assistantText("Here is the answer you asked for."));

  const warning = silentReplyWarning(turn);

  assert.ok(warning, "a reply with no send produced no warning");
  assert.match(warning!, /nobody|no send/i);
});

test("a turn that called send is not warned about", () => {
  const turn = newTurn(true);

  observe(turn, assistantText("Here is the answer."));
  observeToolCall(turn, "mcp__chat__send");

  assert.equal(silentReplyWarning(turn), undefined);
});

test("room_send counts as reaching somebody", () => {
  const turn = newTurn(true);

  observe(turn, assistantText("Posting this to the room."));
  observeToolCall(turn, "mcp__chat__room_send");

  assert.equal(silentReplyWarning(turn), undefined);
});

/**
 * 🛑 THE CONTROL THAT STOPS THIS BEING A STRING TEST. A turn that said NOTHING
 * is #209's case, already covered elsewhere, and warning about it here would
 * fire on every tool-only turn the supervisor runs.
 */
test("a turn that produced no prose at all is NOT this defect", () => {
  const turn = newTurn(true);

  observeToolCall(turn, "Bash");

  assert.equal(silentReplyWarning(turn), undefined);
});

test("whitespace is not prose", () => {
  const turn = newTurn(true);

  observe(turn, assistantText("   \n  "));

  assert.equal(silentReplyWarning(turn), undefined);
});

/**
 * ⚠️ READING THE BUS IS NOT ANSWERING ON IT. An agent that called `inbox` and
 * then wrote prose has still told nobody anything.
 */
test("reading tools do not count as a send", () => {
  for (const name of [
    "mcp__chat__inbox",
    "mcp__chat__room_inbox",
    "mcp__chat__search",
    "mcp__chat__list_agents",
    "mcp__chat__whoami",
    "mcp__chat__set_status",
  ]) {
    const turn = newTurn(true);
    observe(turn, assistantText("I read my messages."));
    observeToolCall(turn, name);

    assert.ok(
      silentReplyWarning(turn),
      `${name} was treated as an outbound send`,
    );
  }
});

test("a send from a DIFFERENT mcp server is not this bus", () => {
  assert.equal(isOutboundChatTool("mcp__other__send"), false);
  assert.equal(isOutboundChatTool("mcp__chat__send"), true);
});

/**
 * ⚠️ UNPREFIXED NAMES ARE ACCEPTED ON PURPOSE. The prefix is the MCP client's,
 * not the bus's, and a driver that reports a bare tool name would otherwise
 * make this detector silently blind rather than loud.
 */
test("a bare tool name still counts", () => {
  assert.equal(isOutboundChatTool("send"), true);
  assert.equal(isOutboundChatTool("room_send"), true);
  assert.equal(isOutboundChatTool("inbox"), false);
});

test("a non-assistant event cannot change the verdict", () => {
  const turn = newTurn(true);

  observe(turn, assistantText("An answer."));
  observe(turn, { type: "result", subtype: "success" });
  observe(turn, { type: "system", message: "anything" });

  assert.ok(silentReplyWarning(turn), "a result event cleared the warning");
});

/**
 * 🛑 ORDER MUST NOT MATTER. An agent that sends BEFORE it writes its closing
 * prose is the common shape, and an order-sensitive detector would warn on it.
 */
test("a send before the prose still counts", () => {
  const turn = newTurn(true);

  observeToolCall(turn, "mcp__chat__send");
  observe(turn, assistantText("Done, I told them."));

  assert.equal(silentReplyWarning(turn), undefined);
});

/**
 * 🛑 THE TWO HALVES ARRIVE SEPARATELY NOW, AND THE PROPERTY IS UNCHANGED.
 * Prose and a send in the same turn clear the warning no matter which input
 * carried each — `observe` reads the text, the driver names the tool. One
 * event used to carry both because this file read Claude Code's blocks
 * directly, which is exactly what made it blind to Cursor. #392.
 */
test("prose and a send in one turn clear the warning, from separate inputs", () => {
  const turn = newTurn(true);

  observe(turn, {
    type: "assistant",
    message: { content: [{ type: "text", text: "Telling them now." }] },
  });
  observeToolCall(turn, "mcp__chat__send");

  assert.equal(silentReplyWarning(turn), undefined);
});

/** A reply owed, prose produced, and a tool call that may have been the send. */
function unnamedTurn(why?: UnnamedToolCall) {
  const turn = newTurn(true);

  observe(turn, {
    type: "assistant",
    message: { content: [{ type: "text", text: "Telling them now." }] },
  });
  observeToolCall(turn, null, why);

  return turn;
}

/**
 * 🛑 AN UNNAMEABLE MCP CALL MAY HAVE BEEN THE SEND, SO THE WARNING MAY NOT
 * BLAME THE AGENT. `mcpToolCall` is the only variant a bus `send` arrives
 * under. #417.
 */
test("🔴 an unnameable MCP call withholds the delivery claim", () => {
  const warning = String(silentReplyWarning(unnamedTurn("unnamed-mcp")));

  assert.match(warning, /UNKNOWN/);
  assert.doesNotMatch(warning, /nobody received it/);
});

/**
 * 🛑 THE SCOPE IS THE POINT, AND THIS IS WHAT STOPS THE FIX OVER-REACHING.
 * An unknown or ambiguous SHAPE is as likely a file read as a send, so
 * softening the warning for those would hide a real lost reply — #392
 * inverted. claude1 raised it on the #417 plan.
 */
test("🔴 an unknown or ambiguous tool SHAPE still gets the confident line", () => {
  for (const why of ["unknown-shape", "ambiguous"] as UnnamedToolCall[]) {
    const warning = String(silentReplyWarning(unnamedTurn(why)));

    assert.match(warning, /nobody received it/, why);
    assert.doesNotMatch(warning, /UNKNOWN/, why);
  }
});

/** A driver that reports no reason at all is not evidence of a send either. */
test("a null name with NO reason still gets the confident line", () => {
  assert.match(String(silentReplyWarning(unnamedTurn())), /nobody received it/);
});

/** An agent that called an unnameable tool AND a real send answered somebody. */
test("a real send outranks an unnameable call", () => {
  const turn = unnamedTurn("unnamed-mcp");

  observeToolCall(turn, "mcp__chat__send");

  assert.equal(silentReplyWarning(turn), undefined);
});

/**
 * 🛑 THIS IS THE NON-VACUITY CONTROL FOR THE THREE TESTS ABOVE. Do not
 * delete it. A fix that returned the UNKNOWN line for EVERY warning case
 * would pass all of them, and only this test notices that the original
 * detector was swallowed.
 */
test("a turn with no tool call at all keeps the original confident line", () => {
  const turn = newTurn(true);

  observe(turn, {
    type: "assistant",
    message: { content: [{ type: "text", text: "Telling them now." }] },
  });

  const warning = String(silentReplyWarning(turn));

  assert.match(warning, /nobody received it/);
  assert.doesNotMatch(warning, /UNKNOWN/);
});

/** A fresh turn must not inherit the previous turn's send. */
test("newTurn does not carry state over", () => {
  const first = newTurn(true);
  observe(first, assistantTool("mcp__chat__send"));

  const second = newTurn(true);
  observe(second, assistantText("A new answer, told to nobody."));

  assert.ok(
    silentReplyWarning(second),
    "the previous turn's send cleared this one",
  );
});

/**
 * 🛑 THE DETECTOR IS USELESS WITHOUT THIS, AND IT WOULD HAVE BEEN NOISE.
 *
 * "Produced prose and called no send" fires on ordinary turns too — a
 * supervisor prompts its child for internal reasons (a grant notice, a model
 * replacement) and nobody is waiting for a reply to those.
 *
 * `supervise/index.ts` builds `messageIds: [envelope.id]` on the inbound
 * bus-message path and nowhere else; every other `queue.offer` in that file
 * offers `messageIds: []`. So a non-empty id list IS the question "was a reply
 * owed".
 */
test("an internally prompted turn is never warned about", () => {
  const turn = newTurn(false);

  observe(turn, assistantText("Acknowledged, nothing to report."));

  assert.equal(silentReplyWarning(turn), undefined);
});

test("owed is what separates a lost reply from an ordinary turn", () => {
  const owed = newTurn(true);
  const internal = newTurn(false);

  for (const turn of [owed, internal])
    observe(turn, assistantText("The same prose in both."));

  assert.ok(
    silentReplyWarning(owed),
    "a reply owed to a peer was not warned about",
  );
  assert.equal(silentReplyWarning(internal), undefined);
});

/**
 * 🛑 A REFUSED SEND CLEARS THE WARNING. This pins a KNOWN GAP, not a fix.
 *
 * `observe` reads the `tool_use` block and never its `tool_result`, so the
 * four paths `shim/tools/send.ts` throws on — over-cap body, send to self, a
 * `#room` target, an unknown peer — all look like a delivered reply.
 *
 * ⚠️ WHEN THE GAP CLOSES THIS TEST GOES RED, naming the two docblocks that
 * must change with it.
 *
 * 🛑 THE `said` PRECONDITION IS NOT DECORATION. `silentReplyWarning` returns
 * `undefined` for a turn that said nothing, so a DEAD `observe` satisfies the
 * final assertion without the gap existing at all. Asserting `said` is what
 * makes a passing `undefined` mean "the gap", and nothing else.
 *
 * ⚠️ DELIBERATELY NO `sent` PRECONDITION. It would fire BEFORE the final
 * assertion on the one trip that matters, replacing "the gap closed, update
 * the docblocks" with "observe is not reading tool_use blocks" — which is
 * false exactly when the gap has been closed properly.
 */
test("a REFUSED send still clears the warning — known gap, not a fix", () => {
  const turn = newTurn(true);

  observe(turn, assistantText("Answering you now."));
  observeToolCall(turn, "mcp__chat__send");
  observe(
    turn,
    toolFailed(
      "Unknown peer: nobody. Call list_agents to see who is registered.",
    ),
  );

  assert.equal(turn.said, true, "observe is not reading text blocks at all");

  assert.equal(
    silentReplyWarning(turn),
    undefined,
    "the refused-send gap closed; update both silent-reply docblocks",
  );
});
