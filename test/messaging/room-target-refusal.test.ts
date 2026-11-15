import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import type { ShimContext } from "../../src/shim/index.js";

// 🛑 BEFORE any import that resolves a state path.
process.env.CHAT_MCP_HOME = mkdtempSync(
  join(tmpdir(), "chat-mcp-roomrefusal-"),
);

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } =
  await import("@modelcontextprotocol/sdk/inMemory.js");
const { openDb } = await import("../../src/storage/db.js");
const { NotifyBus } = await import("../../src/notify/bus.js");
const { buildServer } = await import("../../src/shim/index.js");
const { runSend } = await import("../../src/oneshot/send.js");

/**
 * A room target handed to a peer-only send must be told where rooms live.
 *
 * Both surfaces used to answer with the peer-not-found advice, and that advice
 * reads the `agents` table, where a room can never appear. So an agent that
 * followed it had no next step and looped.
 *
 * ⚠️ The advice differs per surface on purpose. The MCP tool has `room_send`;
 * the one-shot CLI has no room-send verb at all, so its only honest next step
 * is the interactive REPL.
 */

function contextFor(handle: string): ShimContext {
  return {
    handle,
    sandbox: "host",
    session_id: randomUUID(),
    db: openDb(),
    notify: new NotifyBus(handle),
    adapterStatus: { installed: true, framework: null, hint: null },
  };
}

/** The tool's thrown reason, as an agent reads it. */
async function sendToolRefusal(ctx: ShimContext, to: string): Promise<string> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "probe", version: "0" });
  const server = buildServer(ctx);
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

  const result = (await client.callTool({
    name: "send",
    arguments: { to, body: "hi" },
  })) as { isError?: boolean; content: { type: string; text: string }[] };

  await client.close();
  await server.close();

  assert.equal(result.isError, true, `send to ${to} must be refused`);
  const text = result.content[0]?.text;
  assert.ok(text, "the refusal must carry text content");
  return text;
}

/** `runSend`'s thrown reason, as an operator reads it. */
async function oneshotRefusal(to: string): Promise<string> {
  const err = await runSend({ to, body: "hi", from: "rr-operator" }).then(
    () => null,
    (e: unknown) => e as Error,
  );
  assert.ok(err, `chat-mcp send ${to} must be refused`);
  return err.message;
}

/**
 * 🛑 THE SHARED CLAUSE IS THE ONLY REASON `roomTargetRefusal` EXISTS rather
 * than two inline strings, and nothing asserted it. claude1 deleted it on
 * PR 276, keeping only `nextStep`, and the full suite passed 1728/1728 twice.
 * Reproduced here before this test was written.
 */
test("🚨 BOTH surfaces say the target is a room and send is peer-only", async () => {
  const ctx = contextFor(`rr-${process.pid}-d`);
  const text = await sendToolRefusal(ctx, "#mcp");
  ctx.db.close();

  assert.match(
    text,
    /#mcp is a room, and send is peer-only\./,
    "the shared clause names the target and the contract",
  );

  const message = await oneshotRefusal("#mcp");
  assert.match(
    message,
    /#mcp is a room, and send is peer-only\./,
    "the one-shot surface carries the same clause, not a second wording",
  );
});

test("🚨 the send TOOL points a #room at room_send, not at list_agents", async () => {
  const ctx = contextFor(`rr-${process.pid}-a`);
  const text = await sendToolRefusal(ctx, "#mcp");
  ctx.db.close();

  assert.match(text, /room_send/, "the tool that takes a room must be named");
  assert.doesNotMatch(
    text,
    /list_agents/,
    "list_agents reads the agents table, where a room can never appear",
  );
});

test("🚨 the one-shot SEND points a #room at the REPL, not at chat-mcp list", async () => {
  const message = await oneshotRefusal("#mcp");

  assert.match(message, /\/join/, "the REPL step that reaches a room");
  assert.doesNotMatch(
    message,
    /chat-mcp list/,
    "chat-mcp list reads the agents table, where a room can never appear",
  );
});

/**
 * 🛑 THE CONTROL. Both assertions above pass if the refusal becomes
 * room-flavoured for EVERY unknown target, which would strand an operator who
 * simply mistyped a handle. A `#`-less miss must keep its own advice.
 */
test("🚨 a mistyped PEER still gets the peer advice on both surfaces", async () => {
  const ctx = contextFor(`rr-${process.pid}-b`);
  const text = await sendToolRefusal(ctx, "nosuchpeer");
  ctx.db.close();

  assert.match(text, /list_agents/, "a peer miss still names list_agents");
  assert.doesNotMatch(text, /room_send/);

  const message = await oneshotRefusal("nosuchpeer");
  assert.match(
    message,
    /chat-mcp list/,
    "a peer miss still names the list verb",
  );
  assert.doesNotMatch(message, /\/join/);
});

/**
 * 🛑 THE `#` PREFIX DECIDES ROOM-OR-PEER, AND `isRoomName` ONLY DECIDES VALID.
 *
 * `#Ops` carries a capital, so `isRoomName` is false for it while the user's
 * intent is unmistakable. `handleMessagesClear` carries a comment about the
 * same discrimination sending `#Ops` down the DM branch, and keying this
 * refusal on `isRoomName` would reintroduce it one surface over.
 */
test("🚨 an INVALID room name is still a room attempt, not a peer miss", async () => {
  const ctx = contextFor(`rr-${process.pid}-c`);
  const text = await sendToolRefusal(ctx, "#Ops");
  ctx.db.close();

  assert.match(text, /room_send/, "#Ops is a room attempt, capital and all");
  assert.doesNotMatch(text, /list_agents/);

  const message = await oneshotRefusal("#Ops");
  assert.match(message, /\/join/);
  assert.doesNotMatch(message, /chat-mcp list/);
});

/**
 * 🛑 THE ADVICE MUST BE FOLLOWABLE IN ONE HOP, WHICH IS THE WHOLE TICKET.
 *
 * Raised by claude1 on PR 276: the tests above assert the STRING, never the
 * OUTCOME of following it. `/join #Ops` and `room_send room: "#Ops"` are both
 * refused again by `assertRoomName`, so a refusal that only named them sent
 * the reader to a second dead end — the same defect one hop later.
 */
test("🚨 an unusable room name carries its own CORRECTION, not just the verb", async () => {
  const ctx = contextFor(`rr-${process.pid}-e`);
  const text = await sendToolRefusal(ctx, "#Ops");
  ctx.db.close();

  assert.match(
    text,
    /not a valid room name/,
    "naming room_send alone leaves #Ops refused at the next hop",
  );
  assert.match(text, /"#ops"/, "the correction must be the name that works");

  const message = await oneshotRefusal("#Ops");
  assert.match(message, /"#ops"/);
});

/**
 * 🛑 THE CONTROL FOR THE CORRECTION. Lowercasing does not rescue every
 * invalid name, and suggesting `"#a b"` as the fix would be worse than saying
 * nothing. An unfixable name states the rule and suggests no replacement.
 */
test("🚨 a room name lowercasing cannot rescue states the RULE instead", async () => {
  const ctx = contextFor(`rr-${process.pid}-f`);
  const text = await sendToolRefusal(ctx, "#a b");
  ctx.db.close();

  assert.match(text, /not a valid room name/);
  assert.match(
    text,
    /\[a-z0-9\]\[a-z0-9_-\]\{0,63\}/,
    "it must state the rule when it has no working name to offer",
  );
  assert.doesNotMatch(
    text,
    /the one you want is/,
    'there is no lowercase form of "#a b" that works',
  );
});

/**
 * 🛑 THE CONTROL FOR THE NOTE BEING CONDITIONAL. A note appended
 * unconditionally would pass every assertion above while telling a reader
 * with a perfectly good room name that it is invalid.
 */
test("🚨 a VALID room name gets no validity note at all", async () => {
  const ctx = contextFor(`rr-${process.pid}-g`);
  const text = await sendToolRefusal(ctx, "#mcp");
  ctx.db.close();

  assert.doesNotMatch(text, /not a valid room name/);

  const message = await oneshotRefusal("#mcp");
  assert.doesNotMatch(message, /not a valid room name/);
});
