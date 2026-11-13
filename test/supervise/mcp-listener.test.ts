import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';

import type { ShimContext } from '../../src/shim/index.js';

// 🛑 BEFORE any import that resolves a state path.
process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), 'chat-mcp-mcp-listener-'));

const { openDb } = await import('../../src/storage/db.js');
const { NotifyBus } = await import('../../src/notify/bus.js');
const { buildServer } = await import('../../src/shim/index.js');
const { McpHttpListener } = await import('../../src/supervise/mcp-listener.js');
const { mintToken, authenticateToken } = await import('../../src/supervise/handle-tokens.js');

const PROTOCOL = '2025-06-18';

/**
 * Piece A of #191 unit 4: the host-side socket `McpHttpService` deliberately
 * does not own.
 *
 * 🛑 `mcp-http.test.ts` SUPPLIES ITS OWN LISTENER AND MUST KEEP DOING SO. That
 * seam is what proves the service binds nothing, so these tests are a separate
 * file rather than a rewrite of that harness.
 */

async function listener(t: TestContextLike, maxConnections?: number) {
  const open: ShimContext[] = [];

  const l = await McpHttpListener.bind({
    maxConnections,
    authenticate: authenticateToken,
    serverFor: (handle: string) => {
      const ctx: ShimContext = {
        handle,
        session_id: randomUUID(),
        db: openDb(),
        notify: new NotifyBus(handle),
        adapterStatus: { installed: true, framework: null, hint: null },
      };
      open.push(ctx);
      return buildServer(ctx);
    },
  });

  t.after(async () => {
    await l.close();
    for (const ctx of open) {
      await ctx.notify.close();
      ctx.db.close();
    }
  });

  return l;
}

interface TestContextLike {
  after: (fn: () => void | Promise<void>) => void;
}

function initialize(): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 't', version: '0' } },
  });
}

async function post(url: string, body: string, token?: string): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body,
  });
}

test('🚨 the listener binds an OS-assigned port and serves its url', async (t) => {
  const l = await listener(t);

  assert.ok(l.port > 0, `expected a bound port, got ${l.port}`);
  assert.equal(l.url, `http://127.0.0.1:${l.port}/mcp`);
});

/**
 * 🛑 THE ONE ASSERTION THAT CANNOT BE RELAXED. `0.0.0.0` puts every room and
 * every DM on the operator's LAN. Loopback is not a boundary against a
 * container — `host.docker.internal` reaches it, measured — but it is the
 * difference between the machine and the network.
 */
test('🚨 the listener is on loopback, never a wildcard address', async (t) => {
  const l = await listener(t);

  assert.equal(l.address, '127.0.0.1');

  // The control: the claim above is about the REAL socket, not a field.
  await new Promise<void>((resolve, reject) => {
    const probe = connect({ host: '127.0.0.1', port: l.port }, () => {
      probe.destroy();
      resolve();
    });
    probe.once('error', reject);
  });
});

test('🚨 an unauthenticated request is refused 401, before any server is built', async (t) => {
  const l = await listener(t);

  const res = await post(l.url, initialize());

  assert.equal(res.status, 401);
  assert.match(res.headers.get('www-authenticate') ?? '', /Bearer/);
});

/**
 * The paired control for the 401 above: the SAME request with a real token is
 * served. A listener that refused everything would pass that test alone.
 */
test('🚨 a minted token reaches the service and initializes', async (t) => {
  const l = await listener(t);
  const token = mintToken('alice');

  const res = await post(l.url, initialize(), token);

  assert.equal(res.status, 200);
  assert.ok(res.headers.get('mcp-session-id'), 'no session id came back');
});

test('🚨 close() releases the port', async (t) => {
  const l = await listener(t);
  const { port } = l;

  await l.close();

  await assert.rejects(
    () =>
      new Promise<void>((resolve, reject) => {
        const probe = connect({ host: '127.0.0.1', port }, () => {
          probe.destroy();
          resolve();
        });
        probe.once('error', reject);
      }),
    'the port still accepts connections after close()',
  );
});

/**
 * The paired control for `url`: the listener serves ONE path, and the token is
 * not a key to the whole socket.
 *
 * Asserting the absence of `mcp-session-id` is what makes this non-vacuous —
 * the service answers 404 for an unknown session id too, so the status alone
 * would also pass if the path check were missing and a session had opened.
 */
test('🚨 a path other than /mcp opens no session, even with a valid token', async (t) => {
  const l = await listener(t);
  const token = mintToken('alice');

  const res = await post(`http://127.0.0.1:${l.port}/`, initialize(), token);

  assert.equal(res.status, 404);
  assert.equal(res.headers.get('mcp-session-id'), null, 'a session opened off /mcp');
});


/**
 * 🚨 Pre-auth sockets are a host-wide resource: `host.docker.internal` reaches
 * this listener from EVERY container on the machine, and the supervisor holds
 * every handle's session. Without a cap, one container exhausts the
 * supervisor's descriptors before presenting a token.
 */
test('🚨 connections past the cap are dropped, before any token is presented', async (t) => {
  const l = await listener(t, 1);

  const held = connect({ host: '127.0.0.1', port: l.port });
  t.after(() => held.destroy());
  await new Promise<void>((resolve, reject) => {
    held.once('connect', () => resolve());
    held.once('error', reject);
  });

  const extra = connect({ host: '127.0.0.1', port: l.port });
  t.after(() => extra.destroy());

  // The control is that `held` is still usable: the cap drops the EXTRA
  // socket, it does not take the listener down.
  await new Promise<void>((resolve, reject) => {
    extra.once('close', () => resolve());
    extra.once('error', () => resolve());
    setTimeout(() => reject(new Error('the socket past the cap was kept open')), 2000);
  });

  assert.equal(held.destroyed, false, 'the cap killed the connection it should have kept');
});
