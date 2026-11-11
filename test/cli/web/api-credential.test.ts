import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { migrate } from '../../../src/storage/db.js';
import * as dao from '../../../src/storage/dao.js';
import { route, type RouteContext } from '../../../src/cli/web/server.js';
import {
  ALL_CAPABILITIES,
  COOKIE_NAME,
  cookieValue,
  mintToken,
  requiredCapability,
  tokenMatches,
  type Capability,
} from '../../../src/cli/web/credential.js';

/**
 * 🛑 THE BIND ADDRESS WAS THE ONLY THING AUTHORIZING THIS API, AND IT IS NOT AN
 * AUTHORIZATION DECISION. A container reaches the host's `127.0.0.1` through
 * `host.docker.internal`, which Docker Desktop proxies from the host side —
 * measured on #162 by approving a `Bash(rm -rf:*)` grant from inside one.
 *
 * So the refusals below assert the STATUS and, where the route destroys
 * something, that the target survived. A 401 that already answered the
 * approval is not a 401.
 */

const TOKEN = 'token-for-credential-tests';

interface Harness {
  readonly db: DatabaseSync;
  readonly server: Server;
  readonly origin: string;
}

async function harness(capabilities: readonly Capability[] = ALL_CAPABILITIES): Promise<Harness> {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  for (const h of ['operator', 'peer-a']) {
    dao.upsertAgent(db, { handle: h, pid: 1, session_id: h, display_name: h, metadata: {} });
  }

  const ctx: RouteContext = {
    handle: 'operator',
    db,
    sseClients: new Set(),
    port: 0,
    token: TOKEN,
    capabilities,
  };
  const server = createServer((req, res) => { void route(req, res, ctx); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  ctx.port = port;

  return { db, server, origin: `http://127.0.0.1:${port}` };
}

function close(h: Harness): void {
  h.server.closeAllConnections();
  h.server.close();
  h.db.close();
}

const COOKIE = `${COOKIE_NAME}=${TOKEN}`;

// ── The guard itself ─────────────────────────────────────────────────────

test('🛑 an api read with NO credential is refused', async (t) => {
  const h = await harness();
  t.after(() => close(h));
  const res = await fetch(`${h.origin}/api/whoami`);

  assert.equal(res.status, 401);
});

test('⚠️ control — the SAME read succeeds once the credential is presented', async (t) => {
  const h = await harness();
  t.after(() => close(h));
  const res = await fetch(`${h.origin}/api/whoami`, { headers: { Cookie: COOKIE } });

  assert.equal(res.status, 200);
});

test('🛑 an uncredentialed approval answer is refused AND the approval survives unanswered', async (t) => {
  const h = await harness();
  t.after(() => close(h));
  const id = dao.insertApproval(h.db, {
    agentHandle: 'peer-a',
    supervisorHandle: 'operator',
    requested: 'Bash(rm -rf /)',
    grant: 'Bash(rm -rf:*)',
    reason: 'the #162 round trip',
  });

  const res = await fetch(`${h.origin}/api/approvals/answer`, {
    method: 'POST',
    headers: { Origin: h.origin },
    body: JSON.stringify({ id, decision: 'approve' }),
  });

  assert.equal(res.status, 401);
  // THE POINT. A refusal that already granted the permission is not a refusal.
  assert.equal(dao.getApproval(h.db, id)?.decision, null);
  assert.equal(dao.getApproval(h.db, id)?.answeredAt, null);
});

test('a wrong credential is refused, not just a missing one', async (t) => {
  const h = await harness();
  t.after(() => close(h));
  const res = await fetch(`${h.origin}/api/whoami`, {
    headers: { Cookie: `${COOKIE_NAME}=${mintToken()}` },
  });

  assert.equal(res.status, 401);
});

// ── The handshake ────────────────────────────────────────────────────────

test('the handshake trades the token for a cookie and redirects it out of the url', async (t) => {
  const h = await harness();
  t.after(() => close(h));
  const res = await fetch(`${h.origin}/?t=${TOKEN}`, { redirect: 'manual' });

  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/');
  const setCookie = res.headers.get('set-cookie') ?? '';
  assert.match(setCookie, new RegExp(`${COOKIE_NAME}=${TOKEN}`));
  // 🛑 BOTH FLAGS OR THE COOKIE IS READABLE BY PAGE SCRIPT AND RIDES
  // CROSS-SITE REQUESTS.
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
});

test('a handshake with the wrong token sets no cookie', async (t) => {
  const h = await harness();
  t.after(() => close(h));
  const res = await fetch(`${h.origin}/?t=${mintToken()}`, { redirect: 'manual' });

  assert.equal(res.status, 401);
  assert.equal(res.headers.get('set-cookie'), null);
});

// ── Per-route scoping ────────────────────────────────────────────────────

test('🛑 a read-only credential cannot answer an approval, and the approval survives', async (t) => {
  const h = await harness(['read']);
  t.after(() => close(h));
  const id = dao.insertApproval(h.db, {
    agentHandle: 'peer-a',
    supervisorHandle: 'operator',
    requested: 'Bash(rm -rf /)',
    grant: 'Bash(rm -rf:*)',
    reason: 'scoping',
  });

  const res = await fetch(`${h.origin}/api/approvals/answer`, {
    method: 'POST',
    headers: { Origin: h.origin, Cookie: COOKIE },
    body: JSON.stringify({ id, decision: 'approve' }),
  });

  assert.equal(res.status, 403);
  assert.equal(dao.getApproval(h.db, id)?.decision, null);
});

test('a read-only credential still reads', async (t) => {
  const h = await harness(['read']);
  t.after(() => close(h));
  const res = await fetch(`${h.origin}/api/whoami`, { headers: { Cookie: COOKIE } });

  assert.equal(res.status, 200);
});

// ── The capability table ─────────────────────────────────────────────────

test('🛑 an UNLISTED api route defaults to admin, never to read', () => {
  assert.equal(requiredCapability('POST', '/api/something-nobody-classified'), 'admin');
  assert.equal(requiredCapability('DELETE', '/api/also-new'), 'admin');
});

test('the three destructive routes are admin, and the ordinary writes are not', () => {
  for (const p of ['/api/approvals/answer', '/api/kick', '/api/rooms/delete']) {
    assert.equal(requiredCapability('POST', p), 'admin', p);
  }
  for (const p of ['/api/messages', '/api/rooms/join', '/api/rooms/read']) {
    assert.equal(requiredCapability('POST', p), 'write', p);
  }
});

test('a GET is read, and a non-api path needs nothing', () => {
  assert.equal(requiredCapability('GET', '/api/search'), 'read');
  assert.equal(requiredCapability('GET', '/'), null);
  assert.equal(requiredCapability('GET', '/assets/app.js'), null);
});

// ── The primitives ───────────────────────────────────────────────────────

test('tokenMatches refuses null, a prefix, and a longer string', () => {
  assert.equal(tokenMatches('abcdef', 'abcdef'), true);
  assert.equal(tokenMatches('abcdef', null), false);
  assert.equal(tokenMatches('abcdef', 'abc'), false);
  assert.equal(tokenMatches('abcdef', 'abcdefg'), false);
  assert.equal(tokenMatches('abcdef', ''), false);
});

test('cookieValue finds its name among others and does not match a suffix', () => {
  assert.equal(cookieValue('a=1; chat_mcp_api=xyz; b=2', COOKIE_NAME), 'xyz');
  assert.equal(cookieValue('chat_mcp_api=xyz', COOKIE_NAME), 'xyz');
  assert.equal(cookieValue('not_chat_mcp_api=xyz', COOKIE_NAME), null);
  assert.equal(cookieValue(undefined, COOKIE_NAME), null);
});

// ── The storage rule the credential depends on ───────────────────────────

/**
 * 🛑 THE WHOLE STATE DIR IS BIND-MOUNTED READ-WRITE INTO EVERY CONTAINERIZED
 * AGENT, AND A CONTAINER RUNS AS ROOT. Measured on #162: a 0600 host file read
 * straight out of the mount, and another handle's `notify/` file overwritten
 * from inside.
 *
 * `webUrlFile()` lives under `stateDir()`. So writing the handshake url there
 * — the obvious convenience, since external scripts already read that file —
 * would hand the credential to the thing it exists to refuse.
 *
 * Asserted against the source because the swap is a ONE-WORD edit that no
 * behavioural test of the server would notice.
 */
test('🛑 the well-known url file is written WITHOUT the token', () => {
  const src = readFileSync(
    new URL('../../../src/cli/web/server.ts', import.meta.url),
    'utf8',
  );

  const writes = src
    .split('\n')
    .filter((l) => l.includes('writeFile(webUrlFile()'));

  assert.equal(writes.length, 1, 'one write to the well-known file; find them all before trusting this');
  assert.doesNotMatch(
    writes[0]!,
    /handshakeUrl|token/,
    'the well-known file is readable from inside a container; it must carry the plain url',
  );
});
