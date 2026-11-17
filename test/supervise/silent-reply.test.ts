import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isOutboundChatTool,
  newTurn,
  observe,
  silentReplyWarning,
} from "../../src/supervise/silent-reply.js";

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

/** The shape `drivers/claude-events.ts:130` reads a tool failure out of. */
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
  observe(turn, assistantTool("mcp__chat__send"));

  assert.equal(silentReplyWarning(turn), undefined);
});

test("room_send counts as reaching somebody", () => {
  const turn = newTurn(true);

  observe(turn, assistantText("Posting this to the room."));
  observe(turn, assistantTool("mcp__chat__room_send"));

  assert.equal(silentReplyWarning(turn), undefined);
});

/**
 * 🛑 THE CONTROL THAT STOPS THIS BEING A STRING TEST. A turn that said NOTHING
 * is #209's case, already covered elsewhere, and warning about it here would
 * fire on every tool-only turn the supervisor runs.
 */
test("a turn that produced no prose at all is NOT this defect", () => {
  const turn = newTurn(true);

  observe(turn, assistantTool("Bash"));

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
    observe(turn, assistantTool(name));

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

  observe(turn, assistantTool("mcp__chat__send"));
  observe(turn, assistantText("Done, I told them."));

  assert.equal(silentReplyWarning(turn), undefined);
});

test("one event may carry both prose and a send", () => {
  const turn = newTurn(true);

  observe(turn, {
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "Telling them now." },
        { type: "tool_use", name: "mcp__chat__send" },
      ],
    },
  });

  assert.equal(silentReplyWarning(turn), undefined);
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
 * `index.ts:1453` builds `messageIds: [envelope.id]` for an inbound bus
 * message, while `:1148`, `:1168` and `:1280` all offer `messageIds: []`. So
 * a non-empty id list IS the question "was a reply owed".
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
 */
test("a REFUSED send still clears the warning — known gap, not a fix", () => {
  const turn = newTurn(true);

  observe(turn, assistantText("Answering you now."));
  observe(turn, assistantTool("mcp__chat__send"));
  observe(
    turn,
    toolFailed(
      "Unknown peer: nobody. Call list_agents to see who is registered.",
    ),
  );

  assert.equal(
    silentReplyWarning(turn),
    undefined,
    "the refused-send gap closed; update both silent-reply docblocks",
  );
});
