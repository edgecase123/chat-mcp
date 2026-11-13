import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 🛑 BEFORE any import that resolves a state path.
process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), 'chat-mcp-host-bus-'));

const { openHostBus } = await import('../../src/supervise/host-bus.js');
const { openDb } = await import('../../src/storage/db.js');
const dao = await import('../../src/storage/dao.js');

const PROTOCOL = '2025-06-18';

function initialize(): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 't', version: '0' } },
  });
}

/**
 * 🛑 THE HOST BUILDS A `ShimContext` BY HAND, AND THE SHIM'S OWN BUILD HAS ONE
 * MORE STEP. Without the upsert a containerized child is absent from
 * `list_agents`, so a sibling reads it as never started — and `deleteAgent` on
 * teardown removes a row nobody wrote.
 */
test('🚨 a session over the host bus REGISTERS the child on the bus', async (t) => {
  const bus = await openHostBus('claude1-agent');
  t.after(() => bus.close());

  const res = await fetch(bus.endpoint.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${bus.endpoint.token}`,
    },
    body: initialize(),
  });

  assert.equal(res.status, 200);
  await res.text();

  const db = openDb();
  t.after(() => db.close());

  const agent = dao.getAgent(db, 'claude1-agent');

  assert.ok(agent, 'the child never registered, so list_agents cannot see it');
  assert.equal(agent.handle, 'claude1-agent');
});

/**
 * 🛑 THE CONTAINER IS STARTED WITH `--rm`, SO ITS CREDENTIAL OUTLIVES IT. The
 * token was minted when the bus opened and never revoked, and
 * `authenticateToken` reads it off disk — so a leaked token stayed valid
 * against every listener opened afterwards, for a child that no longer exists.
 *
 * 🛑 SAFE ONLY BECAUSE `close()` RUNS AFTER THE TEARDOWN. `supervise/index.ts`
 * kills the child and awaits its teardown first, so revoking here cannot race
 * a live child's own credential.
 */
test('🚨 close() REVOKES the child token, so a dead container cannot come back', async () => {
  const { authenticateToken } = await import('../../src/supervise/handle-tokens.js');

  const bus = await openHostBus('claude1-gone');
  const { token } = bus.endpoint;

  assert.equal(authenticateToken(token), 'claude1-gone', 'the control: it worked while open');

  await bus.close();

  assert.equal(authenticateToken(token), null, 'the token still authenticates a dead container');
});
