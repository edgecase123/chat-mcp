import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import type { ShimContext } from '../../src/shim/index.js';

// 🛑 BEFORE any import that resolves a state path.
process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), 'chat-mcp-mcp-http-'));

const { openDb } = await import('../../src/storage/db.js');
const { NotifyBus } = await import('../../src/notify/bus.js');
const { buildServer } = await import('../../src/shim/index.js');
const { McpHttpService } = await import('../../src/supervise/mcp-http.js');
const { mintToken, authenticateToken } = await import('../../src/supervise/handle-tokens.js');

const PROTOCOL = '2025-06-18';

interface Harness {
  readonly url: string;
  readonly close: () => Promise<void>;

  /** How many servers `serverFor` has been asked for. */
  readonly built: () => number;

  /** How many of those the service has released. */
  readonly released: () => number;

  /** Releases still in flight. See `McpHttpService.releasing`. */
  readonly pending: () => number;
}

/**
 * 🛑 THE LISTENER IS THE TEST'S, NOT THE SERVICE'S. `McpHttpService` binds
 * nothing on purpose — a bound, unauthenticated listener reaching `main` even
 * briefly is reachable from ANY container on the machine through
 * `host.docker.internal`, measured. The test supplies the socket so the
 * service never has to.
 */
async function harness(): Promise<Harness> {
  const open: ShimContext[] = [];
  const released: ShimContext[] = [];
  let closed = false;

  const service = McpHttpService.create({
    authenticate: authenticateToken,
    serverFor: (handle) => {
      const ctx: ShimContext = {
        handle,
        session_id: randomUUID(),
        db: openDb(),
        notify: new NotifyBus(handle),
        adapterStatus: { installed: true, framework: null, hint: null },
      };
      open.push(ctx);

      return {
        server: buildServer(ctx),
        close: async () => {
          released.push(ctx);
          await ctx.notify.close();
          ctx.db.close();
        },
      };
    },
  });

  const http: Server = createServer((req, res) => {
    void service.handleRequest(req, res);
  });

  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));

  const { port } = http.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    built: () => open.length,
    released: () => released.length,
    pending: () => service.pendingReleases,

    // 🛑 IDEMPOTENT. A test that closes to assert the teardown released its
    // contexts is still closed again by its own `t.after`.
    close: async () => {
      if (closed) return;
      closed = true;

      await service.close();
      await new Promise<void>((resolve) => http.close(() => resolve()));

      for (const ctx of open) {
        if (released.includes(ctx)) continue;
        await ctx.notify.close();
        ctx.db.close();
      }
    },
  };
}

function rpc(method: string, params: unknown = {}, id: number | null = 1): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params });
}

const INITIALIZE = rpc('initialize', {
  protocolVersion: PROTOCOL,
  capabilities: {},
  clientInfo: { name: 'probe', version: '0' },
});

interface Reply {
  readonly status: number;
  readonly text: string;
  readonly sessionId: string | null;
}

/**
 * 🛑 READS THE BODY ONCE AND RETURNS IT. A `fetch` Response body can only be
 * consumed once, and an assertion message that interpolates `await res.text()`
 * runs that read EVEN WHEN THE ASSERTION PASSES — which then makes the next
 * read throw `Body is unusable`. That cost one round trip while writing this.
 */
async function post(
  url: string,
  token: string | null,
  body: string,
  sessionId?: string,
): Promise<Reply> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };

  if (token !== null) headers.authorization = `Bearer ${token}`;
  if (sessionId) headers['mcp-session-id'] = sessionId;

  const res = await fetch(url, { method: 'POST', headers, body });

  return {
    status: res.status,
    text: await res.text(),
    sessionId: res.headers.get('mcp-session-id'),
  };
}

/** `post`'s sibling for the methods that carry no body. */
async function bare(
  url: string,
  token: string,
  method: 'GET' | 'DELETE',
  sessionId?: string,
): Promise<Reply> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    accept: 'application/json, text/event-stream',
  };

  if (sessionId) headers['mcp-session-id'] = sessionId;

  const res = await fetch(url, { method, headers });

  return { status: res.status, text: await res.text(), sessionId: null };
}

/** Open a session and return its id, so a later request can try to reuse it. */
async function openSession(url: string, token: string): Promise<string> {
  const res = await post(url, token, INITIALIZE);

  assert.equal(res.status, 200, `initialize failed: ${res.status} ${res.text}`);
  assert.ok(res.sessionId, 'the transport issued no mcp-session-id');

  return res.sessionId;
}

/** Mirrors `MAX_BODY_BYTES` in `mcp-http.ts`. */
const MAX_BODY = 4 * 1024 * 1024;

/**
 * POST nine bytes while DECLARING `length`, and answer with the status.
 *
 * 🛑 `fetch` SETS `content-length` ITSELF and will not let a test lie about it,
 * hence `node:http`. The request is deliberately never ended: a service that
 * honours the declared length answers before the body arrives, and one that
 * does not waits for bytes that never come — so a regression fails on the
 * timeout rather than hanging the suite.
 */
async function declaring(url: string, token: string, length: number): Promise<number> {
  const { request } = await import('node:http');

  return new Promise<number>((resolve, reject) => {
    const req = request(
      url,
      {
        method: 'POST',
        timeout: 5000,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'content-length': String(length),
        },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );

    req.on('timeout', () => {
      req.destroy(new Error(`no answer in 5s for a declared length of ${length}`));
    });
    req.on('error', reject);
    req.write('{"a":"b"}');
  });
}

/**
 * 🛑 THE TEST I WROTE FIRST, BECAUSE IT IS THE REQUIREMENT I GOT WRONG IN MY
 * OWN PROBE. The probe looked the session up AFTER authentication passed, so a
 * valid token for handle Y drove handle X's session and read X's mail.
 *
 * The control is the same request with the session's OWN token. Without it a
 * service that refused every session-bearing request would pass.
 */
test('🛑 a session belongs to ONE handle, so another handle\'s VALID token cannot drive it', async (t) => {
  const h = await harness();

  t.after(h.close);

  const mine = mintToken('http-owner');
  const theirs = mintToken('http-intruder');
  const session = await openSession(h.url, mine);

  const intruder = await post(h.url, theirs, rpc('tools/list', {}, 2), session);

  assert.equal(intruder.status, 403, intruder.text);

  // THE CONTROL. The same session, the same request, its own token.
  const owner = await post(h.url, mine, rpc('tools/list', {}, 3), session);

  assert.equal(owner.status, 200, owner.text);
});

test('🛑 a request with NO token is refused, and the same request with one succeeds', async (t) => {
  const h = await harness();

  t.after(h.close);

  const token = mintToken('http-noauth');

  assert.equal((await post(h.url, null, INITIALIZE)).status, 401);
  assert.equal((await post(h.url, 'Bearer-shaped-but-wrong', INITIALIZE)).status, 401);
  assert.equal((await post(h.url, token, INITIALIZE)).status, 200);
});

/**
 * 🛑 EVERY REQUEST RE-AUTHENTICATES. A session id must not be a bearer on its
 * own, or stealing one header is enough.
 */
test('🛑 a known session id with NO token is refused, so the session id is not itself a credential', async (t) => {
  const h = await harness();

  t.after(h.close);

  const token = mintToken('http-reauth');
  const session = await openSession(h.url, token);

  assert.equal((await post(h.url, null, rpc('tools/list', {}, 2), session)).status, 401);

  // The control: the session is live and the refusal above was about the token.
  assert.equal((await post(h.url, token, rpc('tools/list', {}, 3), session)).status, 200);
});

test('a session id nobody opened is refused even with a valid token', async (t) => {
  const h = await harness();

  t.after(h.close);

  const token = mintToken('http-ghost');
  const res = await post(h.url, token, rpc('tools/list', {}, 2), randomUUID());

  assert.equal(res.status, 404, res.text);
});

/**
 * 🛑 THE HANDLE COMES FROM THE TOKEN, NEVER FROM A FIELD THE CALLER FILLS IN.
 * The served instructions name the handle, so they are the observable proof of
 * which handle the session was built for.
 */
test('🛑 two tokens get servers for their OWN handles, not for whoever connected first', async (t) => {
  const h = await harness();

  t.after(h.close);

  const first = mintToken('http-alice');
  const second = mintToken('http-bob');

  const [a, b] = await Promise.all([
    post(h.url, first, INITIALIZE).then((r) => r.text),
    post(h.url, second, INITIALIZE).then((r) => r.text),
  ]);

  assert.match(a, /http-alice/);
  assert.doesNotMatch(a, /http-bob/);
  assert.match(b, /http-bob/);
  assert.doesNotMatch(b, /http-alice/);
});

/**
 * 🛑 A REQUEST THAT OPENS NO SESSION MUST BUILD NO SERVER. `openSession` ran on
 * every request without a session id, and only an `initialize` ever reaches
 * `onsessioninitialized` — so a bare `GET` left an `McpServer` connected to a
 * transport and absent from `sessions`. `close()` iterates `sessions`, so it
 * never reached them.
 *
 * claude2 measured 200 bare `GET`s as 200 abandoned servers and +806 file
 * descriptors, about four each. The container is the untrusted party here, so
 * it reaches the default 256-fd limit in under 65 requests without ever
 * opening a session.
 */
test('🛑 a request that opens NO session leaves NO server behind, so it cannot exhaust the descriptors', async (t) => {
  const h = await harness();

  t.after(h.close);

  const token = mintToken('http-noleak');

  // Every shape that reaches `openSession` without initializing.
  assert.equal((await post(h.url, token, rpc('tools/list', {}, 2))).status, 400);
  assert.equal((await post(h.url, token, JSON.stringify([rpc('tools/list', {}, 3)]))).status, 400);
  assert.equal((await bare(h.url, token, 'GET')).status, 400);
  assert.equal((await bare(h.url, token, 'DELETE')).status, 400);

  assert.equal(h.built(), 0, 'a request that opened no session still left a server behind');

  // 🛑 THE CONTROL. Without it this passes for a service that never builds a
  // server at all, and `built()` would be proving nothing.
  assert.equal((await post(h.url, token, INITIALIZE)).status, 200);
  assert.equal(h.built(), 1);
});

/**
 * 🛑 THE BODY IS BUFFERED WHOLE BEFORE ANYTHING REFUSES IT, so the cap is the
 * only thing between an authenticated container and the supervisor's memory.
 * Raised by claude2, who read the absence of the cap rather than measuring a
 * cost — and said so.
 *
 * 🛑 IT ASSERTS ON THE DECLARED LENGTH, NOT ON A REAL BIG UPLOAD. An earlier
 * version posted 5 MB and was refused part-way through, which raced the client:
 * it read ECONNRESET instead of the 413 in 3 of 10 runs. Checking
 * `content-length` answers before a byte is read, so this sends nine bytes and
 * is deterministic.
 */
test('🛑 a body DECLARING more than the cap is refused 413 before it is read', async (t) => {
  const h = await harness();

  t.after(h.close);

  const token = mintToken('http-bigbody');

  assert.equal(await declaring(h.url, token, MAX_BODY + 1), 413);

  // 🛑 THE CONTROL. A legal request on the same service is not refused, so the
  // 413 above was the declared length and not the service rejecting everything.
  assert.equal((await post(h.url, token, INITIALIZE)).status, 200);
});

/**
 * 🛑 A SESSION THAT ENDS MUST GIVE BACK ITS DATABASE HANDLE AND ITS POLLER.
 * `onsessionclosed` only dropped the map entry, so a caller could loop
 * initialize → DELETE → initialize on ONE keep-alive connection and accumulate
 * a SQLite handle and a NotifyBus per lap. The socket cap does not reach a
 * serial loop, because it only ever holds one connection.
 */
test('🚨 a DELETEd session RELEASES its context', async (t) => {
  const h = await harness();

  t.after(h.close);

  const token = mintToken('http-release');
  const id = await openSession(h.url, token);

  assert.equal(h.built(), 1);
  assert.equal(h.released(), 0, 'released before the session ended');

  assert.equal((await bare(h.url, token, 'DELETE', id)).status, 200);

  assert.equal(h.released(), 1, 'the DELETEd session never released its context');
});

test('🚨 a serial initialize/DELETE loop accumulates NOTHING', async (t) => {
  const h = await harness();

  t.after(h.close);

  const token = mintToken('http-loop');
  const laps = 5;

  for (let i = 0; i < laps; i++) {
    const id = await openSession(h.url, token);
    assert.equal((await bare(h.url, token, 'DELETE', id)).status, 200);
  }

  assert.equal(h.built(), laps, 'the control: every lap really did build a server');
  assert.equal(h.released(), laps, `${laps - h.released()} of ${laps} contexts were kept`);

  // 🛑 THE BOOKKEEPING MUST NOT ACCUMULATE EITHER, or this test's name is a
  // false claim. The release promises were retained until `close()`, so the
  // service grew one entry per lap while reporting every context released.
  await drained();

  assert.equal(h.pending(), 0, `${h.pending()} release promises were retained after ${laps} laps`);
});

/** Let the in-flight releases settle. Each awaits a NotifyBus and a database handle. */
async function drained(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * 🛑 THE TWO TEARDOWN PATHS MUST AGREE ON ONE OWNER. A session still live when
 * the service closes is released here and nowhere else, and a session already
 * DELETEd must not be released twice.
 */
test('🚨 close() releases a session that is still live, exactly once', async (t) => {
  const h = await harness();

  t.after(h.close);

  const token = mintToken('http-close');
  const live = await openSession(h.url, token);
  const doomed = await openSession(h.url, token);

  assert.equal((await bare(h.url, token, 'DELETE', doomed)).status, 200);
  assert.equal(h.released(), 1);
  assert.ok(live, 'the control: a second session was open');

  await h.close();

  assert.equal(h.released(), 2, 'close() left a live session holding its context');
});
