import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// Type-only, so it is erased and resolves no state path at runtime.
import type { ShimContext } from '../../src/shim/index.js';

// 🛑 BEFORE any import that resolves a state path.
process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), 'chat-mcp-build-server-'));

const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const { openDb } = await import('../../src/storage/db.js');
const { NotifyBus } = await import('../../src/notify/bus.js');
const { buildServer } = await import('../../src/shim/index.js');

/**
 * 🛑 A REAL CLIENT OVER A REAL TRANSPORT, NOT A FAKE `registerTool`.
 *
 * A spy counts the calls `buildServer` makes. It cannot tell whether the tools
 * are reachable, and reachability is the whole claim — #191 serves this same
 * server over HTTP, where a per-session instance is what must answer.
 */
async function toolsOf(ctx: ShimContext): Promise<string[]> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'probe', version: '0' });

  await Promise.all([buildServer(ctx).connect(serverSide), client.connect(clientSide)]);

  const { tools } = await client.listTools();

  await client.close();

  return tools.map((t) => t.name).sort();
}

function contextFor(handle: string): ShimContext {
  return {
    handle,
    session_id: randomUUID(),
    db: openDb(),
    notify: new NotifyBus(handle),
    adapterStatus: { installed: true, framework: null, hint: null },
  };
}

/**
 * 🛑 22 TOOLS, NOT 21 INSTALLERS. The two numbers are different claims and
 * both read "22" in prose, which is how a count test ends up pinning the wrong
 * one. `index.ts` makes 21 `install*` calls; `claims.ts` registers three tools
 * and `installInboxResource` registers none, so 20 tool installers give 22.
 *
 * The SET, not the count. A count alone passes a rename.
 */
const TOOLS = [
  'claim',
  'claims',
  'health',
  'inbox',
  'list_agents',
  'register',
  'release',
  'report_context',
  'room_boot',
  'room_delete',
  'room_inbox',
  'room_join',
  'room_leave',
  'room_list',
  'room_members',
  'room_send',
  'search',
  'send',
  'set_status',
  'set_style',
  'wait_for_message',
  'whoami',
];

test('🛑 buildServer SERVES exactly these 22 TOOLS, so neither a drop nor a rename passes', async (t) => {
  const ctx = contextFor('build-server-probe');

  t.after(async () => {
    await ctx.notify.close();
    ctx.db.close();
  });

  assert.deepEqual(await toolsOf(ctx), TOOLS);
});

test('two contexts get INDEPENDENT servers, which is what per-session HTTP needs', async (t) => {
  const a = contextFor('build-server-a');
  const b = contextFor('build-server-b');

  t.after(async () => {
    await a.notify.close();
    await b.notify.close();
    a.db.close();
    b.db.close();
  });

  // 🛑 THE CONTROL FOR UNIT 2. Sharing one `McpServer` across two transports
  // throws `Already connected to a transport` and kills the process — measured
  // on the #191 probe. Two calls must yield two instances.
  const [first, second] = await Promise.all([toolsOf(a), toolsOf(b)]);

  assert.deepEqual(first, second);
  assert.deepEqual(first, TOOLS);
});
