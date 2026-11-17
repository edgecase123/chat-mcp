import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import type { ShimContext } from "../../src/shim/index.js";

// 🛑 BEFORE any import that resolves a state path.
process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), "chat-mcp-roomdelete-"));

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } =
  await import("@modelcontextprotocol/sdk/inMemory.js");
const { openDb } = await import("../../src/storage/db.js");
const { NotifyBus } = await import("../../src/notify/bus.js");
const { buildServer } = await import("../../src/shim/index.js");
const dao = await import("../../src/storage/dao.js");
const { runDeleteRoom } = await import("../../src/oneshot/delete_room.js");

/**
 * What a refused delete TELLS the caller, asserted LIVE (#127).
 *
 * 🛑 A FILE-TEXT PIN ON THESE TWO STRINGS IS VACUOUS. `room-delete-copy.test.ts`
 * matched the phrase anywhere in the file, and this repo quotes copy in
 * docblocks everywhere — so cutting the thrown message down to `caller is not
 * a member.` and leaving the advice as a `//` comment passed 4 of 4. Found by
 * claude1 on PR 288. A comment cannot satisfy the assertions below.
 *
 * The advice differs per surface on purpose: the MCP tool can say "join first
 * to confirm the room exists", and the one-shot CLI has no room-join verb.
 */

const RULE =
  /owner while they are still a member, and any member once they have left/;

/** Advice that names a handle which is itself refused in the case it describes. */
const MISDIRECTS = /ask a current member|ask its owner/i;

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

function agent(ctx: ShimContext, handle: string): void {
  dao.upsertAgent(ctx.db, {
    handle,
    pid: 1,
    session_id: handle,
    display_name: handle,
    metadata: {},
  });
}

async function connected(
  ctx: ShimContext,
): Promise<InstanceType<typeof Client>> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "probe", version: "0" });
  const server = buildServer(ctx);
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

  return client;
}

/** The tool's thrown reason, as an agent reads it. */
async function toolRefusal(ctx: ShimContext, room: string): Promise<string> {
  const client = await connected(ctx);
  const result = (await client.callTool({
    name: "room_delete",
    arguments: { room },
  })) as { isError?: boolean; content: { type: string; text: string }[] };

  await client.close();

  assert.equal(result.isError, true, `deleting ${room} must be refused`);
  const text = result.content[0]?.text;
  assert.ok(text, "the refusal must carry text content");

  return text;
}

/** `runDeleteRoom`'s thrown reason, as an operator reads it. */
async function oneshotRefusal(room: string, from: string): Promise<string> {
  const err = await runDeleteRoom({ room, from }).then(
    () => null,
    (e: unknown) => e as Error,
  );
  assert.ok(err, `chat-mcp delete-room ${room} must be refused`);

  return err.message;
}

// ── the control comes first ──────────────────────────────────────────────

test("CONTROL — the tool deletes a room its caller owns", async () => {
  const ctx = contextFor("ctl-owner");
  agent(ctx, "ctl-owner");
  dao.joinRoom(ctx.db, "#ctl", "ctl-owner");

  const client = await connected(ctx);
  const result = (await client.callTool({
    name: "room_delete",
    arguments: { room: "#ctl" },
  })) as { isError?: boolean; content: { type: string; text: string }[] };

  await client.close();

  // Without this, every refusal below would pass on a tool that refused
  // everything, including the deletes it is supposed to allow.
  assert.notEqual(result.isError, true, result.content[0]?.text);
  assert.equal(dao.roomOwner(ctx.db, "#ctl"), undefined, "the room survived");
});

// ── the not-a-member refusal, on both surfaces ───────────────────────────

test("🛑 THE TOOL'S not-a-member REFUSAL STATES THE RULE AND NAMES NOBODY", async () => {
  const ctx = contextFor("outsider");
  agent(ctx, "outsider");
  agent(ctx, "roomowner");
  dao.joinRoom(ctx.db, "#owned", "roomowner");

  const message = await toolRefusal(ctx, "#owned");

  assert.match(message, /is not a member/, message);
  assert.match(message, /Join first/, message);
  assert.match(message, RULE, message);

  // 🛑 THE POINT OF THE REWORD. "ask its owner" names the one handle that is
  // itself refused in the case the same sentence describes: once the owner has
  // left they are not a member either, so they get this very message back.
  assert.doesNotMatch(message, MISDIRECTS, message);
});

test("🛑 THE ONE-SHOT'S not-a-member REFUSAL STATES THE RULE AND NAMES NOBODY", async () => {
  const ctx = contextFor("setup-oneshot");
  agent(ctx, "cli-outsider");
  agent(ctx, "cli-owner");
  dao.joinRoom(ctx.db, "#cliowned", "cli-owner");
  ctx.db.close();

  const message = await oneshotRefusal("#cliowned", "cli-outsider");

  assert.match(message, /is not a member/, message);
  assert.match(message, /Join first/, message);
  assert.match(message, RULE, message);
  assert.doesNotMatch(message, MISDIRECTS, message);
});

// ── the owner-only refusal is a DIFFERENT message, and names the owner ───

test("the owner-only refusal names the owner, because the caller is already a member", async () => {
  const ctx = contextFor("plain-member");
  agent(ctx, "plain-member");
  agent(ctx, "first-joiner");
  dao.joinRoom(ctx.db, "#shared", "first-joiner");
  dao.joinRoom(ctx.db, "#shared", "plain-member");

  const message = await toolRefusal(ctx, "#shared");

  // Naming a handle is right HERE and wrong above: this caller IS a member, so
  // the owner's handle is not news to them and asking is actionable.
  assert.match(message, /first-joiner/, message);
  assert.doesNotMatch(message, /is not a member/, message);
});

// ── the live descriptions, which a docblock also cannot launder ──────────

test("🛑 THE TOOL DESCRIPTION AN AGENT ACTUALLY RECEIVES CARRIES THE RULE", async () => {
  const ctx = contextFor("lister");
  agent(ctx, "lister");

  const client = await connected(ctx);
  const tools = await client.listTools();
  await client.close();

  const tool = tools.tools.find((t) => t.name === "room_delete");

  assert.ok(tool, "room_delete was never registered");
  assert.match(
    tool.description ?? "",
    /owner-only while the owner is still a member/,
    tool.description ?? "(no description)",
  );
  assert.match(
    tool.description ?? "",
    /any member may delete once the owner has left/,
    tool.description ?? "(no description)",
  );
});

test("🛑 THE SERVER INSTRUCTIONS AN AGENT ACTUALLY RECEIVES CARRY THE RULE", async () => {
  const ctx = contextFor("instructed");
  agent(ctx, "instructed");

  const client = await connected(ctx);
  const instructions = client.getInstructions();
  await client.close();

  assert.ok(instructions, "the server sent no instructions at all");

  const bullet = instructions
    .split("\n")
    .find((l) => l.includes("`room_delete`"));

  assert.ok(bullet, "the instructions never mention room_delete");
  assert.match(bullet, /owner-only while the owner is still a member/, bullet);
  assert.match(bullet, /any member may delete once the owner has left/, bullet);
});
