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
      return buildServer(ctx);
    },
  });

  const http: Server = createServer((req, res) => {
    void service.handleRequest(req, res);
  });

  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));

  const { port } = http.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: async () => {
      await service.close();
      await new Promise<void>((resolve) => http.close(() => resolve()));
      for (const ctx of open) {
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

/** Open a session and return its id, so a later request can try to reuse it. */
async function openSession(url: string, token: string): Promise<string> {
  const res = await post(url, token, INITIALIZE);

  assert.equal(res.status, 200, `initialize failed: ${res.status} ${res.text}`);
  assert.ok(res.sessionId, 'the transport issued no mcp-session-id');

  return res.sessionId;
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
