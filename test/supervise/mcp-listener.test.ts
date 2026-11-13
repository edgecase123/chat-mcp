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
  const l = await listener(t, { maxConnections: 1, receiveTimeoutMs: 150 });

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
  const l = await listener(t, { maxConnections: 1, receiveTimeoutMs: 150 });

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
 * 🛑 THE PAIRED CONTROL FOR EVERY RECLAIM, AND THE REASON THE DEADLINE IS
 * DISARMED ON A FULLY RECEIVED REQUEST. The transport answers over SSE and a standing stream
 * is SILENT for as long as the agent is thinking, so a plain idle timeout would
 * cut the stream the caller is waiting on — the outage the cap was supposed to
 * prevent, from the other side.
 */
test('🚨 a standing SSE stream OUTLIVES the receive deadline', async (t) => {
  const l = await listener(t, { receiveTimeoutMs: 150 });
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

  assert.equal(verdict, 'still open', 'the receive deadline cut a live SSE stream');
});

/**
 * 🛑 THE DRIBBLE. An INACTIVITY timer cannot bound this: one byte resets it, so
 * a caller holds a slot forever at a byte every fraction of the timeout. The
 * reclaim has to be an ABSOLUTE deadline on an incomplete request.
 *
 * Found by claude2 reviewing `282a6e6`, which shipped the inactivity timer and
 * a comment claiming this was closed.
 */
test('🚨 a body dribbled one byte at a time does NOT hold the slot', async (t) => {
  const l = await listener(t, { maxConnections: 1, receiveTimeoutMs: 300 });

  const slow = connect({ host: '127.0.0.1', port: l.port });
  t.after(() => slow.destroy());
  await new Promise<void>((resolve, reject) => {
    slow.once('connect', () => resolve());
    slow.once('error', reject);
  });

  slow.resume();
  slow.write(
    'POST /mcp HTTP/1.1\r\n' +
      'host: 127.0.0.1\r\n' +
      'content-type: application/json\r\n' +
      'content-length: 4096\r\n\r\n',
  );

  const dribble = setInterval(() => {
    if (!slow.destroyed) slow.write('x');
  }, 50);
  t.after(() => clearInterval(dribble));

  await closedWithin(slow, 3000, 'a dribbled body held the slot past 10x the deadline');
});

/**
 * Declare a one-byte body, then deliver that byte only AFTER the refusal has
 * come back. Resolves once the owed byte is on the wire.
 *
 * 🛑 THE `data` LISTENER GOES ON BEFORE THE WRITE. It is what puts the socket
 * in flowing mode, and a `resume()` after the write discards the refusal this
 * waits for.
 */
async function deliverOwedByteAfterRefusal(
  t: TestContextLike,
  port: number,
  path: string,
  extraHeaders = '',
  method = 'POST',
): Promise<{ socket: Socket; status: number }> {
  const sock = connect({ host: '127.0.0.1', port });

  // 🛑 BRACED, BECAUSE `destroy()` RETURNS THE SOCKET. `TestContextLike.after`
  // takes `void | Promise<void>`, and the void-return exemption does not apply
  // to a union — so the bare arrow is a TS2322 that `npm test` cannot see and
  // CI's `tsc --noEmit` does not read, because `tsconfig.json` is `src/` only.
  t.after(() => {
    sock.destroy();
  });

  await new Promise<void>((resolve, reject) => {
    sock.once('connect', () => resolve());
    sock.once('error', reject);
  });

  // 🛑 THE STATUS IS READ, NOT ASSUMED. Without it these tests pass against a
  // listener that refuses on a DIFFERENT path than the one they name — the 403
  // test fell through to the transport, which closes anyway, and still passed
  // with the 403 branch disabled. Found by claude2.
  const refused = new Promise<number>((resolve) => {
    sock.once('data', (chunk: Buffer) => {
      const line = /HTTP\/1\.1 (\d{3})/.exec(chunk.toString('utf8'));

      resolve(line === null ? 0 : Number(line[1]));
    });
  });

  sock.write(
    `${method} ${path} HTTP/1.1\r\n` +
      'host: 127.0.0.1\r\n' +
      'content-type: application/json\r\n' +
      extraHeaders +
      'content-length: 1\r\n\r\n',
  );

  const status = await refused;

  sock.write('x');
  sock.resume();

  return { socket: sock, status };
}

/**
 * 🚨 THE LOCKOUT, AND IT NEEDS NO CREDENTIAL. The refusal closes the response
 * while a declared body is still owed, so `res.on('close')` re-arms the
 * deadline — and the late `end` behind it then disarmed what had just been
 * armed. Nothing re-armed after that, so the slot was held until the caller
 * exited.
 *
 * 🛑 THE DEADLINE IS KEYED ON THE REQUEST, NOT THE SOCKET. `arm`/`disarm` are
 * per socket and were called per request, and that mismatch is the bug rather
 * than the timeout value.
 */
test('🚨 an owed body delivered AFTER a 401 does not clear the slot deadline', async (t) => {
  const l = await listener(t, { maxConnections: 1, receiveTimeoutMs: 200 });

  const { socket: held, status } = await deliverOwedByteAfterRefusal(t, l.port, '/mcp');

  assert.equal(status, 401, 'this test did not exercise the 401 path');
  await closedWithin(held, 3000, 'a 401-refused socket held the slot after delivering its owed body');
});

/**
 * 🛑 `serve()` ANSWERS AN OFF-PATH REQUEST BEFORE `handleRequest`, so the body
 * is never read. A valid token here is what proves the path check, not the
 * token, is what returns early.
 */
test('🚨 an owed body delivered AFTER an off-path 404 does not clear the slot deadline', async (t) => {
  const l = await listener(t, { maxConnections: 1, receiveTimeoutMs: 200 });

  const { socket: held, status } = await deliverOwedByteAfterRefusal(
    t,
    l.port,
    '/not-mcp',
    `authorization: Bearer ${mintToken('alice')}\r\n`,
  );

  assert.equal(status, 404, 'this test did not exercise the off-path 404');
  await closedWithin(held, 3000, 'an off-path socket held the slot after delivering its owed body');
});

/**
 * 🛑 `readJsonBody` RETURNS WITHOUT READING FOR ANY NON-POST METHOD, so the
 * refusals BELOW it in `handleRequest` are pre-body too. Call order is not read
 * order, and reasoning from the order alone said these were safe. The ticket
 * said 403 was exposed and the ticket was right; claude2 measured it.
 *
 * This is the strongest of the three: the token is VALID and the session is
 * LIVE, so nothing short of the request-keyed deadline reclaims the slot.
 */
test('🚨 an owed body delivered AFTER a 403 on a DELETE does not clear the slot deadline', async (t) => {
  const l = await listener(t, { receiveTimeoutMs: 200 });

  const opened = await post(l.url, initialize(), mintToken('bob'));
  const session = opened.headers.get('mcp-session-id');
  assert.ok(session, 'no session id came back');
  await opened.text();

  const { socket: held, status } = await deliverOwedByteAfterRefusal(
    t,
    l.port,
    '/mcp',
    `authorization: Bearer ${mintToken('alice')}\r\nmcp-session-id: ${session}\r\n`,
    'DELETE',
  );

  assert.equal(status, 403, 'this test did not exercise the 403 path');
  await closedWithin(held, 3000, 'a 403-refused DELETE held the slot after delivering its owed body');
});

/**
 * 🚨 THE VARIANT THE REQUEST-KEYED DEADLINE DOES NOT REACH. `res.on('close')`
 * re-arms from ZERO after every response, refusals included, so the clock
 * measures time since the last response rather than time on the socket. A
 * caller re-sending a 30-byte unauthenticated request before each deadline held
 * its slot indefinitely — measured at 2 of 2 slots at 6000ms against a 200ms
 * deadline, with a valid-token agent refused ECONNRESET.
 *
 * 🛑 A LONGER DEADLINE CANNOT FIX THIS. The attacker re-sends before whatever
 * the deadline is, so the socket needs its own budget.
 */
test('🚨 a socket that is only ever REFUSED is reclaimed however often it re-sends', async (t) => {
  const l = await listener(t, { maxConnections: 1, receiveTimeoutMs: 1000, maxUnauthenticatedRefusals: 3 });

  const poker = connect({ host: '127.0.0.1', port: l.port });
  t.after(() => poker.destroy());
  await new Promise<void>((resolve, reject) => {
    poker.once('connect', () => resolve());
    poker.once('error', reject);
  });

  poker.resume();

  // 🛑 FASTER THAN THE DEADLINE ON PURPOSE. A reclaim here must be the budget
  // running out, not the deadline expiring, or the test proves nothing new.
  const poke = setInterval(() => {
    if (!poker.destroyed) poker.write('GET /mcp HTTP/1.1\r\nhost: 127.0.0.1\r\n\r\n');
  }, 50);
  t.after(() => clearInterval(poke));

  await closedWithin(poker, 900, 'a socket re-sending refused requests held the slot past its budget');
});

/**
 * 🛑 THE PAIRED CONTROL, AND THE REASON THE BUDGET SCORES THE CREDENTIAL AND
 * NOT THE STATUS. A real agent is refused too — a stale session id answers 404
 * with a perfectly good token — and the budget must never reach it.
 *
 * 🛑 NO SUCCESSFUL REQUEST FIRST, AND THAT IS THE WHOLE POINT. An earlier
 * version sent a 200 before the refusals and passed while the rule still cut a
 * real agent on a FRESH socket. Found by claude2, measured `[404,404,404,404]`
 * then destroyed.
 *
 * 🛑 A RAW SOCKET, BECAUSE `fetch` CANNOT SEE THIS FAIL. An even earlier
 * version used `fetch` and passed against every mutant — undici reconnects
 * transparently, so the destroyed socket was replaced and the status stayed
 * 404. It could not have said no.
 */
test('🚨 a VALID token is never budgeted, however often it is refused', async (t) => {
  const LIMIT = 3;
  const l = await listener(t, { receiveTimeoutMs: 2000, maxUnauthenticatedRefusals: LIMIT });
  const token = mintToken('alice');

  const sock = connect({ host: '127.0.0.1', port: l.port });
  t.after(() => sock.destroy());
  await new Promise<void>((resolve, reject) => {
    sock.once('connect', () => resolve());
    sock.once('error', reject);
  });

  const statuses: number[] = [];
  let buffered = '';

  sock.on('data', (chunk) => {
    buffered += chunk.toString('utf8');

    const seen = buffered.match(/HTTP\/1\.1 (\d{3})/g) ?? [];

    while (statuses.length < seen.length) statuses.push(Number(seen[statuses.length].slice(9)));
  });

  // Three times the budget, every one refused, on a socket that never succeeded.
  const refusals = LIMIT * 3;

  for (let i = 0; i < refusals; i++) {
    sock.write(
      'DELETE /mcp HTTP/1.1\r\n' +
        'host: 127.0.0.1\r\n' +
        `authorization: Bearer ${token}\r\n` +
        `mcp-session-id: ${randomUUID()}\r\n\r\n`,
    );

    const deadline = Date.now() + 3000;

    while (statuses.length < i + 1) {
      if (sock.destroyed) {
        throw new Error(`a valid token was cut after ${i} refusals, under a budget of ${LIMIT}`);
      }

      if (Date.now() > deadline) throw new Error(`timed out waiting for refusal ${i + 1}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  assert.equal(sock.destroyed, false, 'a socket presenting a valid token was cut');
  assert.deepEqual(
    statuses,
    Array.from({ length: refusals }, () => 404),
    'a refusal answered something other than 404, so this control exercised the wrong path',
  );
});
