import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import type { ShimContext } from '../../src/shim/index.js';

// 🛑 BEFORE any import that resolves a state path.
process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), 'chat-mcp-wirekeys-'));

const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const { openDb } = await import('../../src/storage/db.js');
const { NotifyBus } = await import('../../src/notify/bus.js');
const { buildServer } = await import('../../src/shim/index.js');
const dao = await import('../../src/storage/dao.js');

/**
 * 🛑 THE WIRE KEY IS WHAT AN AGENT READS, AND NOTHING ASSERTED IT.
 *
 * `room-send-online-count.test.ts` covers `sendToRoom`'s RETURN. This file
 * covers the JSON the tool hands an agent, which is a separate claim: the
 * handler could drop or rename the key and that file would stay green while
 * every agent silently fell back to reading `notified` — the exact defect #229
 * is about, arriving through the one layer no test touched.
 *
 * ⚠️ The two now share a spelling, which makes the gap EASIER to miss, not
 * harder. A rename in the handler alone is still invisible to the other file.
 *
 * Raised by claude2 reviewing PR 237, as the one finding they would not merge
 * without. `grep -rn "online_members" test/` returned zero.
 */

const DEAD_PID = 4194303;

function contextFor(handle: string): ShimContext {
  return {
    handle,
    session_id: randomUUID(),
    db: openDb(),
    notify: new NotifyBus(handle),
    adapterStatus: { installed: true, framework: null, hint: null },
  };
}

/** One live member besides the sender, and one that is not. */
function seed(ctx: ShimContext, room: string, sender: string) {
  for (const [handle, pid] of [[sender, process.pid], ['live-peer', process.pid], ['dead-peer', DEAD_PID]] as const) {
    dao.upsertAgent(ctx.db, { handle, pid, session_id: handle, display_name: handle, metadata: {}, force: true });
    dao.joinRoom(ctx.db, room, handle);
  }
}

async function callRoomSend(ctx: ShimContext, room: string) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'probe', version: '0' });
  const server = buildServer(ctx);
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

  const result = await client.callTool({ name: 'room_send', arguments: { room, body: 'hi' } });

  // Both halves, or a connected server leaks per call.
  await client.close();
  await server.close();

  const content = (result as { content: { type: string; text: string }[] }).content;
  assert.equal(content[0]?.type, 'text', 'room_send must answer with text content');

  return JSON.parse(content[0]!.text) as Record<string, unknown>;
}

test('🚨 room_send serialises online_members on the wire, in snake case', async () => {
  const sender = `wk-${process.pid}-a`;
  const room = `#${sender}`;
  const ctx = contextFor(sender);
  seed(ctx, room, sender);

  const payload = await callRoomSend(ctx, room);

  assert.ok(
    Object.prototype.hasOwnProperty.call(payload, 'online_members'),
    `the wire key is missing; got ${JSON.stringify(Object.keys(payload))}`,
  );
  assert.equal(payload.online_members, 1, 'only live-peer is live and not the sender');
  ctx.db.close();
});

/**
 * 🛑 THE CONTROL. A handler that emitted `online_members` by copying
 * `notified` would pass the test above whenever every member happened to be
 * live. The fixture's dead member is what separates them.
 */
test('🚨 the two wire keys carry DIFFERENT numbers when a member is dead', async () => {
  const sender = `wk-${process.pid}-b`;
  const room = `#${sender}`;
  const ctx = contextFor(sender);
  seed(ctx, room, sender);

  const payload = await callRoomSend(ctx, room);

  assert.equal(payload.notified, 2, 'both non-senders were written to');
  assert.equal(payload.online_members, 1);
  assert.notEqual(payload.notified, payload.online_members, 'the keys must not be the same figure');
  ctx.db.close();
});

/** `notified` must keep its own wire key and meaning — lee ruled this twice. */
test('🚨 notified is still on the wire, unchanged', async () => {
  const sender = `wk-${process.pid}-c`;
  const room = `#${sender}`;
  const ctx = contextFor(sender);
  seed(ctx, room, sender);

  const payload = await callRoomSend(ctx, room);

  assert.ok(Object.prototype.hasOwnProperty.call(payload, 'notified'), 'notified vanished from the wire');
  assert.equal(payload.notified, 2);
  ctx.db.close();
});

/** The whole wire shape, so an added or renamed key cannot pass unseen. */
test('🚨 the room_send wire shape is exactly these five keys', async () => {
  const sender = `wk-${process.pid}-d`;
  const room = `#${sender}`;
  const ctx = contextFor(sender);
  seed(ctx, room, sender);

  const payload = await callRoomSend(ctx, room);

  assert.deepEqual(
    Object.keys(payload).sort(),
    ['message_id', 'notified', 'online_members', 'room', 'sent_at'].sort(),
  );
  ctx.db.close();
});
