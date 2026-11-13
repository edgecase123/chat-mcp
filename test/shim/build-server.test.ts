import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// Type-only, so it is erased and resolves no state path at runtime.
import type { ShimContext } from '../../src/shim/index.js';
import type { AdapterStatus } from '../../src/shim/adapter-check.js';

// 🛑 BEFORE any import that resolves a state path.
process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), 'chat-mcp-build-server-'));

const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const { McpError, ErrorCode } = await import('@modelcontextprotocol/sdk/types.js');
const { openDb } = await import('../../src/storage/db.js');
const { NotifyBus } = await import('../../src/notify/bus.js');
const { buildServer } = await import('../../src/shim/index.js');

interface Served {
  tools: string[];
  resources: string[];
  instructions: string;
}

/**
 * 🛑 A REAL CLIENT OVER A REAL TRANSPORT, NOT A FAKE `registerTool`.
 *
 * A spy counts the calls `buildServer` makes. It cannot tell whether the tools
 * are reachable, and reachability is the whole claim — #191 serves this same
 * server over HTTP, where a per-session instance is what must answer.
 *
 * Returns every surface `buildServer` installs. Tools alone let a dropped
 * `install*` call that registers a RESOURCE pass unseen.
 */
async function served(ctx: ShimContext): Promise<Served> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'probe', version: '0' });
  const server = buildServer(ctx);

  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

  const { tools } = await client.listTools();
  const resources = await listResources(client);
  const instructions = client.getInstructions() ?? '';

  // Both halves. Closing only the client leaks a connected server per call,
  // which unit 2's live-session count cannot tell apart from a real session.
  await client.close();
  await server.close();

  return {
    tools: tools.map((t) => t.name).sort(),
    resources: resources.sort(),
    instructions,
  };
}

/**
 * 🛑 REGISTERING NO RESOURCE DROPS THE CAPABILITY, so `resources/list` answers
 * `-32601 Method not found` rather than an empty list. Letting that throw makes
 * one missing installer fail every assertion in this file, which hides WHICH
 * surface broke. Absent is reported as empty so each surface fails alone.
 */
async function listResources(client: InstanceType<typeof Client>): Promise<string[]> {
  try {
    const { resources } = await client.listResources();
    return resources.map((r) => r.uri);
  } catch (err) {
    if (err instanceof McpError && err.code === ErrorCode.MethodNotFound) return [];
    throw err;
  }
}

function contextFor(handle: string, adapterStatus?: AdapterStatus): ShimContext {
  return {
    handle,
    session_id: randomUUID(),
    db: openDb(),
    notify: new NotifyBus(handle),
    adapterStatus: adapterStatus ?? { installed: true, framework: null, hint: null },
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

  assert.deepEqual((await served(ctx)).tools, TOOLS);
});

/**
 * 🛑 THE 21st INSTALLER REGISTERS A RESOURCE, NOT A TOOL. Asserting tools
 * alone leaves `installInboxResource` unpinned — measured at 1305/1305 green
 * with the call commented out.
 */
test('🛑 buildServer SERVES the inbox RESOURCE, which the TOOL set cannot see', async (t) => {
  const ctx = contextFor('build-server-resource');

  t.after(async () => {
    await ctx.notify.close();
    ctx.db.close();
  });

  assert.deepEqual((await served(ctx)).resources, ['chat-inbox://build-server-resource']);
});

/**
 * 🛑 THE INSTRUCTIONS ARE THE FIRST THING A CLIENT READS, and dropping the
 * option is as invisible as dropping an installer. The two assertions are a
 * pair: an installed adapter must NOT carry the banner, a missing one MUST.
 */
test('🛑 buildServer SERVES instructions naming the handle, with NO warning when the adapter is installed', async (t) => {
  const ctx = contextFor('build-server-instructions');

  t.after(async () => {
    await ctx.notify.close();
    ctx.db.close();
  });

  const { instructions } = await served(ctx);

  assert.match(instructions, /handle "build-server-instructions"/);
  assert.doesNotMatch(instructions, /WAKE ADAPTER NOT INSTALLED/);
});

test('🛑 a MISSING wake adapter puts its hint in the SERVED instructions, which is how an agent learns its wake is not armed', async (t) => {
  const ctx = contextFor('build-server-no-adapter', {
    installed: false,
    framework: 'claude-code',
    hint: 'HINT-SENTINEL',
  });

  t.after(async () => {
    await ctx.notify.close();
    ctx.db.close();
  });

  const { instructions } = await served(ctx);

  assert.match(instructions, /WAKE ADAPTER NOT INSTALLED/);
  assert.match(instructions, /HINT-SENTINEL/);
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
  const [first, second] = await Promise.all([served(a), served(b)]);

  assert.deepEqual(first.tools, second.tools);
  assert.deepEqual(first.tools, TOOLS);

  // The resource URI carries the handle, so one shared server would serve one
  // handle's inbox to both.
  assert.deepEqual(first.resources, ['chat-inbox://build-server-a']);
  assert.deepEqual(second.resources, ['chat-inbox://build-server-b']);
});
