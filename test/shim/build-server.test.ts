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

test('🛑 buildServer SERVES all 22 tools, so a transport swap cannot silently drop one', async (t) => {
  const ctx = contextFor('build-server-probe');

  t.after(async () => {
    await ctx.notify.close();
    ctx.db.close();
  });

  const names = await toolsOf(ctx);

  // The COUNT is the guard. 20 installer files register 22 tools, because
  // `claims.ts` registers three. A dropped `install*` call fails here.
  assert.equal(names.length, 22, `expected 22 tools, got ${names.length}: ${names.join(', ')}`);

  // A spot-check per family, so a count that stays 22 while a name changes
  // still fails.
  for (const expected of ['whoami', 'send', 'inbox', 'room_join', 'claims', 'health', 'search']) {
    assert.ok(names.includes(expected), `missing tool "${expected}" in: ${names.join(', ')}`);
  }
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
  assert.equal(first.length, 22);
});
