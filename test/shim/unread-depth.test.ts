import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import type { ShimContext } from "../../src/shim/index.js";

// 🛑 BEFORE any import that resolves a state path.
process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), "chat-mcp-unread-"));

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } =
  await import("@modelcontextprotocol/sdk/inMemory.js");
const { openDb } = await import("../../src/storage/db.js");
const { NotifyBus } = await import("../../src/notify/bus.js");
const { buildServer } = await import("../../src/shim/index.js");
const dao = await import("../../src/storage/dao.js");

/**
 * #224 defect 2 — an agent holding 25 unread messages looked identical to an
 * idle one with an empty inbox. The depth existed in the database and on the
 * notify payload, and the two tools an agent actually calls to orient itself
 * did not carry it.
 *
 * ⚠️ THE NOTIFY PAYLOAD IS NOT A SUBSTITUTE. It reaches an agent that is
 * already being woken. Nothing told an agent arriving cold, a peer deciding
 * whether to hand work over, or an operator reading the roster.
 */

const DEAD_PID = 4194303;

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

function register(ctx: ShimContext, handle: string, pid = process.pid): void {
  dao.upsertAgent(ctx.db, {
    handle,
    pid,
    session_id: handle,
    display_name: handle,
    metadata: {},
    force: true,
  });
}

async function callTool(
  ctx: ShimContext,
  name: string,
): Promise<Record<string, unknown>> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "probe", version: "0" });
  const server = buildServer(ctx);
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

  const result = await client.callTool({ name, arguments: {} });

  // Both halves, or a connected server leaks per call.
  await client.close();
  await server.close();

  const content = (result as { content: { type: string; text: string }[] })
    .content;
  assert.equal(
    content[0]?.type,
    "text",
    `${name} must answer with text content`,
  );

  return JSON.parse(content[0]!.text) as Record<string, unknown>;
}

async function listAgents(
  ctx: ShimContext,
): Promise<Record<string, unknown>[]> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "probe", version: "0" });
  const server = buildServer(ctx);
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

  const result = await client.callTool({ name: "list_agents", arguments: {} });

  await client.close();
  await server.close();

  const content = (result as { content: { type: string; text: string }[] })
    .content;
  assert.equal(
    content[0]?.type,
    "text",
    "list_agents must answer with text content",
  );

  return JSON.parse(content[0]!.text) as Record<string, unknown>[];
}

function rowFor(
  rows: Record<string, unknown>[],
  handle: string,
): Record<string, unknown> {
  const row = rows.find((r) => r.handle === handle);
  assert.ok(
    row,
    `${handle} is missing; got ${JSON.stringify(rows.map((r) => r.handle))}`,
  );

  return row;
}

test("🚨 list_agents carries unread on the wire, in snake case", async () => {
  const me = `ur-${process.pid}-a`;
  const peer = `${me}-peer`;
  const ctx = contextFor(me);
  register(ctx, me);
  register(ctx, peer);

  dao.insertMessage(ctx.db, { from: peer, to: me, body: "one" });

  const rows = await listAgents(ctx);

  assert.ok(
    Object.prototype.hasOwnProperty.call(rowFor(rows, me), "unread"),
    `the wire key is missing; got ${JSON.stringify(Object.keys(rowFor(rows, me)))}`,
  );
  assert.equal(rowFor(rows, me).unread, 1);
  ctx.db.close();
});

/**
 * 🛑 THE CONTROL. A handler emitting one agent's depth for every row, or a
 * hardcoded zero, passes the test above whenever the fixture holds a single
 * agent with a single message. Two agents at DIFFERENT depths separate them.
 */
test("🚨 each row carries ITS OWN depth, not the caller own", async () => {
  const me = `ur-${process.pid}-b`;
  const peer = `${me}-peer`;
  const idle = `${me}-idle`;
  const ctx = contextFor(me);
  for (const h of [me, peer, idle]) register(ctx, h);

  dao.insertMessage(ctx.db, { from: peer, to: me, body: "one" });
  dao.insertMessage(ctx.db, { from: peer, to: me, body: "two" });
  dao.insertMessage(ctx.db, { from: me, to: peer, body: "just one back" });

  const rows = await listAgents(ctx);

  assert.equal(rowFor(rows, me).unread, 2, "the caller holds two");
  assert.equal(rowFor(rows, peer).unread, 1, "the peer holds one");
  assert.equal(
    rowFor(rows, idle).unread,
    0,
    "an idle agent reads zero, not null",
  );
  ctx.db.close();
});

/**
 * 🛑 ZERO AND ABSENT MUST NOT BE THE SAME READING. `notify/bus.ts` documents
 * that an agent seeing no `unread` must read if it cares, so a tool emitting
 * nothing for an empty inbox would be indistinguishable from a tool that does
 * not carry the key at all.
 */
test("🚨 an empty inbox reads as 0, and the key is still present", async () => {
  const me = `ur-${process.pid}-c`;
  const ctx = contextFor(me);
  register(ctx, me);

  const rows = await listAgents(ctx);

  assert.ok(Object.prototype.hasOwnProperty.call(rowFor(rows, me), "unread"));
  assert.equal(rowFor(rows, me).unread, 0);
  ctx.db.close();
});

/**
 * 🛑 ONE COUNT ACROSS BOTH CHANNELS, OR IT LICENSES SKIPPING THE READ.
 * `dao.totalUnreadFor`'s docblock records the incident: a per-channel count
 * reported 1 while a DM also waited, and the DM was lost.
 */
test("🚨 the depth sums DMs and room messages, not one channel", async () => {
  const me = `ur-${process.pid}-d`;
  const peer = `${me}-peer`;
  const room = `#${me}`;
  const ctx = contextFor(me);
  register(ctx, me);
  register(ctx, peer);
  dao.joinRoom(ctx.db, room, me);
  dao.joinRoom(ctx.db, room, peer);

  // ⚠️ MEASURED, NOT ASSUMED: `joinRoom` posts "<handle> joined <room>" as a
  // system message, and the peer's notice is unread for me. A fixed expected
  // total here would pin this test to that unrelated behaviour.
  const before = rowFor(await listAgents(ctx), me).unread as number;

  dao.insertMessage(ctx.db, { from: peer, to: me, body: "a dm" });
  dao.insertMessage(ctx.db, { from: peer, to: room, body: "a room post" });

  const after = rowFor(await listAgents(ctx), me).unread as number;

  assert.equal(
    after - before,
    2,
    `one DM plus one room post is two; ${before} -> ${after}`,
  );
  ctx.db.close();
});

/**
 * 🛑 THE CONTROL FOR THE TEST ABOVE. A delta of 2 is also what a DM-only count
 * would produce if the fixture's room post happened to land in the inbox. This
 * pins the room half on its own.
 */
test("🚨 a room post alone moves the depth, with no DM involved", async () => {
  const me = `ur-${process.pid}-d2`;
  const peer = `${me}-peer`;
  const room = `#${me}`;
  const ctx = contextFor(me);
  register(ctx, me);
  register(ctx, peer);
  dao.joinRoom(ctx.db, room, me);
  dao.joinRoom(ctx.db, room, peer);

  const before = rowFor(await listAgents(ctx), me).unread as number;

  dao.insertMessage(ctx.db, { from: peer, to: room, body: "a room post" });

  const after = rowFor(await listAgents(ctx), me).unread as number;

  assert.equal(
    after - before,
    1,
    `the room half is not counted; ${before} -> ${after}`,
  );
  ctx.db.close();
});

test("🚨 whoami carries my own depth", async () => {
  const me = `ur-${process.pid}-e`;
  const peer = `${me}-peer`;
  const ctx = contextFor(me);
  register(ctx, me);
  register(ctx, peer);

  dao.insertMessage(ctx.db, { from: peer, to: me, body: "one" });
  dao.insertMessage(ctx.db, { from: peer, to: me, body: "two" });
  dao.insertMessage(ctx.db, { from: peer, to: me, body: "three" });

  const payload = await callTool(ctx, "whoami");

  assert.ok(
    Object.prototype.hasOwnProperty.call(payload, "unread"),
    `whoami dropped the key; got ${JSON.stringify(Object.keys(payload))}`,
  );
  assert.equal(payload.unread, 3);
  ctx.db.close();
});

/**
 * The peer's depth is what makes a hand-off decision possible — #229's "ask a
 * dockerized agent for a review and nothing is running to read it" is the same
 * shape with a different cause.
 */
test("🚨 whoami carries each online peer own depth", async () => {
  const me = `ur-${process.pid}-f`;
  const busy = `${me}-busy`;
  const ctx = contextFor(me);
  register(ctx, me);
  register(ctx, busy);

  dao.insertMessage(ctx.db, { from: me, to: busy, body: "one" });
  dao.insertMessage(ctx.db, { from: me, to: busy, body: "two" });

  const payload = await callTool(ctx, "whoami");
  const peers = payload.online_peers as Record<string, unknown>[];

  assert.equal(
    rowFor(peers, busy).unread,
    2,
    `peers were ${JSON.stringify(peers)}`,
  );
  assert.equal(payload.unread, 0, "my own depth is separate and still zero");
  ctx.db.close();
});

/**
 * 🛑 AN OFFLINE AGENT IS THE ONE WHOSE BACKLOG MATTERS MOST, because nothing
 * is draining it. A count that only ever appears for a live row would hide
 * exactly the case an operator needs.
 */
test("🚨 an offline agent still reports its depth", async () => {
  const me = `ur-${process.pid}-g`;
  const gone = `${me}-gone`;
  const ctx = contextFor(me);
  register(ctx, me);
  register(ctx, gone, DEAD_PID);

  dao.insertMessage(ctx.db, { from: me, to: gone, body: "one" });

  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "probe", version: "0" });
  const server = buildServer(ctx);
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const result = await client.callTool({
    name: "list_agents",
    arguments: { include_offline: true },
  });
  await client.close();
  await server.close();

  const rows = JSON.parse(
    (result as { content: { text: string }[] }).content[0]!.text,
  ) as Record<string, unknown>[];

  assert.equal(
    rowFor(rows, gone).online,
    false,
    "the fixture pid must be dead",
  );
  assert.equal(rowFor(rows, gone).unread, 1);
  ctx.db.close();
});
