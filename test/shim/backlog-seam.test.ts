import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import type { ShimContext } from "../../src/shim/index.js";

// 🛑 BEFORE any import that resolves a state path.
process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), "chat-mcp-seam-"));

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } =
  await import("@modelcontextprotocol/sdk/inMemory.js");
const { openDb } = await import("../../src/storage/db.js");
const { NotifyBus } = await import("../../src/notify/bus.js");
const { buildServer } = await import("../../src/shim/index.js");
const dao = await import("../../src/storage/dao.js");

/**
 * #224 defect 2, unit 3b — the SEAM, not the state machine.
 *
 * 🛑 `backlog-check.test.ts` PROVES THE MODULE AND CANNOT PROVE IT IS CALLED.
 * The bands shipped on this branch three commits before anything invoked them,
 * and a green suite said nothing about it. These tests go through the real MCP
 * tool so a seam that is deleted fails here.
 */

const MIN = 60_000;

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

function register(ctx: ShimContext, handle: string): void {
  dao.upsertAgent(ctx.db, {
    handle,
    pid: process.pid,
    session_id: handle,
    display_name: handle,
    metadata: {},
    force: true,
  });
}

/** The raw first text block, which is a refusal message rather than JSON. */
async function callToolText(
  ctx: ShimContext,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "probe", version: "0" });
  const server = buildServer(ctx);
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

  const result = await client.callTool({ name, arguments: args });

  await client.close();
  await server.close();

  const content = (result as { content: { type: string; text: string }[] })
    .content;

  return String(content[0]?.text ?? "");
}

async function callTool(
  ctx: ShimContext,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "probe", version: "0" });
  const server = buildServer(ctx);
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

  const result = await client.callTool({ name, arguments: args });

  await client.close();
  await server.close();

  const content = (result as { content: { type: string; text: string }[] })
    .content;
  assert.equal(content[0]?.type, "text", `${name} must answer with text`);

  return JSON.parse(content[0]!.text) as Record<string, unknown>;
}

/** A DM from `from` to `to`, back-dated `minutesAgo`. */
function agedDm(
  ctx: ShimContext,
  from: string,
  to: string,
  minutesAgo: number,
): void {
  const sent = dao.insertMessage(ctx.db, {
    from,
    to,
    body: "are you there",
    kind: "chat",
  });
  ctx.db
    .prepare(`UPDATE messages SET sent_at = ? WHERE id = ?`)
    .run(Date.now() - minutesAgo * MIN, sent.id);
}

function systemWarnings(ctx: ShimContext, handle: string): string[] {
  return dao
    .pendingInbox(ctx.db, { to: handle })
    .filter((m) => m.from_handle === dao.SYSTEM_HANDLE)
    .map((m) => m.body);
}

test("🚨 send TICKS the backlog check, so an ignored DM fires", async () => {
  const me = `seam-${process.pid}-a`;
  const peer = `seam-${process.pid}-b`;
  const ctx = contextFor(me);
  register(ctx, me);
  register(ctx, peer);

  agedDm(ctx, peer, me, 7);
  assert.deepEqual(systemWarnings(ctx, me), [], "nothing has fired yet");

  const out = await callTool(ctx, "send", { to: peer, body: "unrelated work" });

  assert.ok(out.message_id, "the send itself still succeeds");
  const fired = systemWarnings(ctx, me);
  assert.equal(fired.length, 1, "the agent's own send fired the 5-min band");
  assert.match(String(fired[0]), /unread bus messages/);
  assert.equal(dao.getAgent(ctx.db, me)?.unread_warned_threshold, 5);
});

test("🚨 room_send TICKS it too", async () => {
  const me = `seam-${process.pid}-c`;
  const peer = `seam-${process.pid}-d`;
  const room = `#seam-${process.pid}`;
  const ctx = contextFor(me);
  register(ctx, me);
  register(ctx, peer);
  dao.joinRoom(ctx.db, room, me);

  agedDm(ctx, peer, me, 7);
  assert.deepEqual(systemWarnings(ctx, me), [], "nothing has fired yet");

  const out = await callTool(ctx, "room_send", { room, body: "status" });

  assert.ok(out.message_id, "the post itself still succeeds");
  assert.equal(
    systemWarnings(ctx, me).length,
    1,
    "a room post is a send, so it ticks the check",
  );
});

test("a send with an EMPTY inbox fires nothing", async () => {
  const me = `seam-${process.pid}-e`;
  const peer = `seam-${process.pid}-f`;
  const ctx = contextFor(me);
  register(ctx, me);
  register(ctx, peer);

  await callTool(ctx, "send", { to: peer, body: "hello" });

  assert.deepEqual(systemWarnings(ctx, me), []);
  assert.equal(dao.getAgent(ctx.db, me)?.unread_warned_threshold, null);
});

test("a REFUSED send does not tick, because nothing was sent", async () => {
  const me = `seam-${process.pid}-g`;
  const peer = `seam-${process.pid}-h`;
  const ctx = contextFor(me);
  register(ctx, me);
  register(ctx, peer);
  agedDm(ctx, peer, me, 7);

  const refusal = await callToolText(ctx, "send", {
    to: "nobody-at-all",
    body: "x",
  });
  assert.match(refusal, /Unknown peer/, "the send really was refused");

  assert.deepEqual(
    systemWarnings(ctx, me),
    [],
    "a refusal is not a liveness signal the agent earned",
  );
});
