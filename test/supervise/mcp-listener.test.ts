import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { connect, type Socket } from 'node:net';

import type { ShimContext } from '../../src/shim/index.js';
import type { McpListenerOptions } from '../../src/supervise/mcp-listener.js';

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

async function listener(t: TestContextLike, overrides: Partial<McpListenerOptions> = {}) {
  const open: ShimContext[] = [];

  const l = await McpHttpListener.bind({
    ...overrides,
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
  const l = await listener(t, { maxConnections: 1 });

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

/** Resolve when the socket closes, or reject at the deadline. */
async function closedWithin(socket: Socket, ms: number, why: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(why)), ms);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };

    socket.once('close', done);
    socket.once('error', done);
  });
}

/**
 * 🚨 A CAP WITHOUT A RECLAIM IS A LOCKOUT PRIMITIVE, NOT A DEFENCE. A container
 * opens `maxConnections` sockets and sends NOTHING; the real agent is refused
 * until Node reclaims them, and the only thing that does so is `headersTimeout`
 * — and NEITHER `headersTimeout` NOR `requestTimeout` does so, measured. So the
 * cap converts a resource attack into an indefinite outage.
 */
test('🚨 a connection that never sends headers is reclaimed on the configured timeout', async (t) => {
  const l = await listener(t, { maxConnections: 1, idleTimeoutMs: 150 });

  const silent = connect({ host: '127.0.0.1', port: l.port });
  t.after(() => silent.destroy());
  await new Promise<void>((resolve, reject) => {
    silent.once('connect', () => resolve());
    silent.once('error', reject);
  });

  await closedWithin(silent, 2000, 'a silent pre-header socket held the slot');
});

/**
 * 🛑 A SECOND DOOR INTO THE SAME SLOT. Headers that declare a body and a body
 * that never arrives is not the same state as a silent socket, and Node's
 * `requestTimeout` did not reclaim either one — measured at 300 ms, still open
 * at 2s.
 */
test('🚨 a request that declares a body and never sends it is reclaimed too', async (t) => {
  const l = await listener(t, { maxConnections: 1, idleTimeoutMs: 150 });

  const slow = connect({ host: '127.0.0.1', port: l.port });
  t.after(() => slow.destroy());
  await new Promise<void>((resolve, reject) => {
    slow.once('connect', () => resolve());
    slow.once('error', reject);
  });

  // 🛑 `resume()` OR THIS NEVER SEES THE CLOSE. The refusal is written before
  // the socket is destroyed, and a paused socket never drains past that data to
  // reach the FIN behind it.
  slow.resume();
  slow.write(
    'POST /mcp HTTP/1.1\r\n' +
      'host: 127.0.0.1\r\n' +
      'content-type: application/json\r\n' +
      'content-length: 4096\r\n\r\n',
  );

  await closedWithin(slow, 3000, 'a half-sent body held the slot');
});

/**
 * 🛑 THE PAIRED CONTROL FOR BOTH RECLAIMS, AND THE REASON THE TIMER IS ARMED
 * ONLY BETWEEN REQUESTS. The transport answers over SSE and a standing stream
 * is SILENT for as long as the agent is thinking, so a plain idle timeout would
 * cut the stream the caller is waiting on — the outage the cap was supposed to
 * prevent, from the other side.
 */
test('🚨 a standing SSE stream OUTLIVES the idle timeout', async (t) => {
  const l = await listener(t, { idleTimeoutMs: 150 });
  const token = mintToken('alice');

  const opened = await post(l.url, initialize(), token);
  const session = opened.headers.get('mcp-session-id');
  assert.ok(session, 'no session id came back');
  await opened.text();

  const controller = new AbortController();
  t.after(() => controller.abort());

  const stream = await fetch(l.url, {
    headers: {
      accept: 'text/event-stream',
      authorization: `Bearer ${token}`,
      'mcp-session-id': session,
    },
    signal: controller.signal,
  });

  assert.equal(stream.status, 200);

  const reader = (stream.body as ReadableStream<Uint8Array>).getReader();
  const read = reader.read().then(
    () => 'ended',
    () => 'errored',
  );

  // Four times the idle timeout, with nothing on the wire in either direction.
  const verdict = await Promise.race([
    read,
    new Promise<string>((resolve) => setTimeout(() => resolve('still open'), 600)),
  ]);

  assert.equal(verdict, 'still open', 'the idle reclaim cut a live SSE stream');
});
