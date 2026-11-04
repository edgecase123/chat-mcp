import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { migrate } from '../../../src/storage/db.js';
import * as dao from '../../../src/storage/dao.js';
import { route, type RouteContext } from '../../../src/cli/web/server.js';

/**
 * 🛑 THESE ENDPOINTS DESTROY DATA. /api/kick deletes an agent and every room
 * membership it holds; /api/rooms/delete deletes a room and every message ever
 * sent to it. Neither comes back.
 *
 * So every refusal below asserts the TARGET SURVIVED, not just the status
 * code. A guard that returns 403 after acting is still a 403.
 *
 * Driven through a real http server rather than a mock req/res, because the
 * Origin guard sits in the request path and a mock is free to not have one.
 */

interface Harness {
  readonly db: DatabaseSync;
  readonly server: Server;
  readonly origin: string;
}

async function harness(handle = 'operator'): Promise<Harness> {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  for (const h of [handle, 'peer-a', 'peer-b']) {
    dao.upsertAgent(db, { handle: h, pid: 1, session_id: h, display_name: h, metadata: {} });
  }
  // Assigned after listen; every request is served after that.
  const ctx: RouteContext = { handle, db, sseClients: new Set(), port: 0 };
  const server = createServer((req, res) => { void route(req, res, ctx); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  ctx.port = port;

  return { db, server, origin: `http://127.0.0.1:${port}` };
}

function close(h: Harness): void {
  // ⚠️ close() alone leaves fetch's keep-alive sockets open and the test
  // runner never exits. Measured: the file hung past an 8s per-test timeout.
  h.server.closeAllConnections();
  h.server.close();
  h.db.close();
}

/**
 * 🛑 RAW, BECAUSE fetch() CANNOT SET `Host`. It is a forbidden header name and
 * undici drops it silently, so a rebinding test written with fetch quietly
 * tests the Origin check instead and passes for the wrong reason.
 */
function raw(
  h: Harness,
  opts: { path: string; method?: string; host?: string; origin?: string; body?: string },
): Promise<{ status: number; body: string }> {
  const { port } = new URL(h.origin);
  const headers: Record<string, string> = {};
  if (opts.host !== undefined) headers.Host = opts.host;
  if (opts.origin !== undefined) headers.Origin = opts.origin;

  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port: Number(port), path: opts.path, method: opts.method ?? 'GET', headers },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => { text += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
      },
    );
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

async function post(h: Harness, path: string, body: unknown, origin?: string): Promise<Response> {
  return fetch(`${h.origin}${path}`, {
    method: 'POST',
    headers: origin === undefined ? {} : { Origin: origin },
    body: JSON.stringify(body),
  });
}

// ── The CSRF guard ───────────────────────────────────────────────────────

test('a cross-site POST cannot kick, and the agent survives it', async () => {
  const h = await harness();
  const res = await post(h, '/api/kick', { handle: 'peer-a' }, 'https://evil.example');

  assert.equal(res.status, 403);
  assert.match((await res.json() as { error: string }).error, /cross-origin/);
  // THE POINT. A refusal that already deleted the row is not a refusal.
  assert.notEqual(dao.getAgent(h.db, 'peer-a'), null);
  close(h);
});

test('a cross-site POST cannot delete a room, and the room survives it', async () => {
  const h = await harness();
  dao.joinRoom(h.db, '#ops', 'operator');

  const res = await post(h, '/api/rooms/delete', { room: '#ops' }, 'https://evil.example');

  assert.equal(res.status, 403);
  assert.ok(dao.isRoomMember(h.db, '#ops', 'operator'), '#ops was deleted by a refused request');
  close(h);
});

test('the guard reads Origin, not Content-Type: text/plain is refused too', async () => {
  const h = await harness();
  const res = await fetch(`${h.origin}/api/kick`, {
    method: 'POST',
    // A CORS-simple request. No preflight, so the browser would send it.
    headers: { 'Content-Type': 'text/plain', Origin: 'https://evil.example' },
    body: JSON.stringify({ handle: 'peer-a' }),
  });

  assert.equal(res.status, 403);
  assert.notEqual(dao.getAgent(h.db, 'peer-a'), null);
  close(h);
});

test('🚨 DNS REBINDING: a matching Host and Origin pair is still refused', async () => {
  const h = await harness();
  // An attacker who points evil.example at 127.0.0.1 makes the browser send
  // BOTH headers as evil.example. Compared against each other they match,
  // and the request is genuinely same-origin, so replies are readable too.
  const evil = `evil.example:${new URL(h.origin).port}`;
  const res = await raw(h, {
    path: '/api/kick', method: 'POST',
    host: evil, origin: `http://${evil}`,
    body: JSON.stringify({ handle: 'peer-a' }),
  });

  assert.equal(res.status, 403);
  assert.match(res.body, /unexpected host/);
  assert.notEqual(dao.getAgent(h.db, 'peer-a'), null, 'rebinding kicked the agent');
  close(h);
});

test('a rebound GET is refused too, though it carries no Origin to check', async () => {
  const h = await harness();
  const evil = `evil.example:${new URL(h.origin).port}`;
  // An <img> or <script> load sends no Origin at all, so only the Host
  // check can stop this one.
  const res = await raw(h, { path: '/api/whoami', host: evil });

  assert.equal(res.status, 403);
  close(h);
});

test('localhost is accepted as well as 127.0.0.1, since both reach the same server', async () => {
  const h = await harness();
  const port = new URL(h.origin).port;
  const res = await raw(h, {
    path: '/api/kick', method: 'POST',
    host: `localhost:${port}`, origin: `http://localhost:${port}`,
    body: JSON.stringify({ handle: 'nobody' }),
  });

  assert.equal(res.status, 404, 'a legitimate localhost caller was blocked');
  close(h);
});

test('the page the server itself serves is not blocked', async () => {
  const h = await harness();
  const res = await post(h, '/api/kick', { handle: 'peer-a' }, h.origin);

  assert.equal(res.status, 200);
  assert.equal(dao.getAgent(h.db, 'peer-a'), null);
  close(h);
});

test('a request with no Origin at all is not blocked', async () => {
  const h = await harness();
  const res = await post(h, '/api/kick', { handle: 'peer-a' });

  assert.equal(res.status, 200);
  close(h);
});

// ── Kick, mirroring the Ink CLI's three refusals ─────────────────────────

test('kick refuses yourself, and you survive it', async () => {
  const h = await harness();
  const res = await post(h, '/api/kick', { handle: 'operator' }, h.origin);

  assert.equal(res.status, 400);
  assert.notEqual(dao.getAgent(h.db, 'operator'), null);
  close(h);
});

test('kick refuses the system handle', async () => {
  const h = await harness();
  const res = await post(h, '/api/kick', { handle: dao.SYSTEM_HANDLE }, h.origin);

  assert.equal(res.status, 400);
  close(h);
});

test('kick reports an unregistered handle rather than succeeding quietly', async () => {
  const h = await harness();
  const res = await post(h, '/api/kick', { handle: 'nobody' }, h.origin);

  assert.equal(res.status, 404);
  close(h);
});

test('kick refuses a missing handle', async () => {
  const h = await harness();
  const res = await post(h, '/api/kick', {}, h.origin);

  assert.equal(res.status, 400);
  close(h);
});

test('kick removes the agent and its room memberships', async () => {
  const h = await harness();
  dao.joinRoom(h.db, '#ops', 'peer-a');

  const res = await post(h, '/api/kick', { handle: 'peer-a' }, h.origin);

  assert.equal(res.status, 200);
  assert.equal(dao.getAgent(h.db, 'peer-a'), null);
  assert.equal(dao.isRoomMember(h.db, '#ops', 'peer-a'), false);
  close(h);
});

// ── Room delete ──────────────────────────────────────────────────────────

test('deleting a room you are not in is refused, and the room survives', async () => {
  const h = await harness();
  dao.joinRoom(h.db, '#theirs', 'peer-a');

  const res = await post(h, '/api/rooms/delete', { room: '#theirs' }, h.origin);

  assert.equal(res.status, 403);
  assert.ok(dao.isRoomMember(h.db, '#theirs', 'peer-a'), 'a non-member deleted the room');
  close(h);
});

test('a member can delete the room, and its messages go with it', async () => {
  const h = await harness();
  dao.joinRoom(h.db, '#ops', 'operator');
  dao.insertMessage(h.db, { from: 'operator', to: '#ops', body: 'a secret' });
  // By body, not by room: joinRoom posts its own "joined" announcement, so a
  // room-wide count is 2 and asserting 1 fails for a reason that is not the
  // one under test.
  const count = (): number => (h.db
    .prepare('SELECT COUNT(*) AS n FROM messages WHERE to_handle = ? AND body = ?')
    .get('#ops', 'a secret') as { n: number }).n;
  assert.equal(count(), 1, 'fixture never stored the message, so its deletion proves nothing');

  const res = await post(h, '/api/rooms/delete', { room: '#ops' }, h.origin);

  assert.equal(res.status, 200);
  assert.equal(dao.isRoomMember(h.db, '#ops', 'operator'), false);
  assert.equal(count(), 0);
  close(h);
});

// ── POST /api/messages/clear (#88) ───────────────────────────────────────

/**
 * 🛑 COUNTS ARE READ, NEVER HARDCODED. `joinRoom` posts a SYSTEM join banner,
 * so a room seeded with one message holds two. A literal `1` here passed for
 * the wrong reason and then failed for the right one.
 */
function countTo(h: Harness, target: string): number {
  const row = h.db
    .prepare('SELECT COUNT(*) AS n FROM messages WHERE to_handle = ?')
    .get(target) as { n: number };
  return row.n;
}

test('a member clears a room, gets the count, and the watermarks reset', async () => {
  const h = await harness();
  try {
    dao.joinRoom(h.db, '#ops', 'operator');
    dao.insertMessage(h.db, { from: 'operator', to: '#ops', body: 'one' });
    dao.insertMessage(h.db, { from: 'peer-a', to: '#ops', body: 'two' });
    const before = countTo(h, '#ops');

    const res = await post(h, '/api/messages/clear', { target: '#ops' }, h.origin);

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { cleared: before });
    assert.equal(countTo(h, '#ops'), 0);
    // deleteRoomMessages also zeroes read watermarks. Asserted so a route that
    // only deletes rows fails here rather than silently skipping every member
    // past a stale watermark.
    const read = h.db
      .prepare('SELECT last_read_id AS n FROM room_reads WHERE room_name = ? AND handle = ?')
      .get('#ops', 'operator') as { n: number } | undefined;
    assert.equal(read?.n ?? 0, 0);
  } finally {
    close(h);
  }
});

test('a NON-member cannot clear a room, and the messages survive', async () => {
  const h = await harness();
  try {
    dao.joinRoom(h.db, '#ops', 'peer-a');
    dao.insertMessage(h.db, { from: 'peer-a', to: '#ops', body: 'one' });
    const before = countTo(h, '#ops');

    const res = await post(h, '/api/messages/clear', { target: '#ops' }, h.origin);

    assert.equal(res.status, 403);
    // THE POINT. A refusal that already deleted the rows is not a refusal.
    assert.equal(countTo(h, '#ops'), before);
  } finally {
    close(h);
  }
});

/**
 * ⚠️ The 403 here comes from the Origin guard, which sits AHEAD of routing, so
 * this half passes even with no route at all. The count assertion is the part
 * that is specific to this endpoint, and the test is kept because it fails the
 * day somebody registers the route above the guard.
 */
test('a cross-site POST cannot clear a room, and the messages survive', async () => {
  const h = await harness();
  try {
    dao.joinRoom(h.db, '#ops', 'operator');
    dao.insertMessage(h.db, { from: 'operator', to: '#ops', body: 'one' });
    const before = countTo(h, '#ops');

    const res = await post(h, '/api/messages/clear', { target: '#ops' }, 'https://evil.example');

    assert.equal(res.status, 403);
    assert.equal(countTo(h, '#ops'), before);
  } finally {
    close(h);
  }
});

test('clearing a DM takes both directions and leaves another peer alone', async () => {
  const h = await harness();
  try {
    // No joinRoom, so no SYSTEM banner. These three are the only rows.
    dao.insertMessage(h.db, { from: 'operator', to: 'peer-a', body: 'mine to a' });
    dao.insertMessage(h.db, { from: 'peer-a', to: 'operator', body: 'a to me' });
    dao.insertMessage(h.db, { from: 'operator', to: 'peer-b', body: 'mine to b' });

    const res = await post(h, '/api/messages/clear', { target: 'peer-a' }, h.origin);

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { cleared: 2 });
    assert.equal(countTo(h, 'peer-a'), 0);
    assert.equal(countTo(h, 'operator'), 0);
    // A separate pair. Clearing one conversation must not reach another.
    assert.equal(countTo(h, 'peer-b'), 1);
  } finally {
    close(h);
  }
});

test('a clear with no target is refused', async () => {
  const h = await harness();
  try {
    const res = await post(h, '/api/messages/clear', {}, h.origin);
    assert.equal(res.status, 400);
  } finally {
    close(h);
  }
});

/**
 * 🛑 THE CLIENT AND SERVER MUST AGREE ON WHAT A ROOM IS. `app.js` calls
 * anything starting with `#` a room and warns that the delete hits everyone.
 * `isRoomName` is stricter, so a malformed name used to fall through to the
 * DM branch, skip the membership check and answer `cleared: 0` as success.
 */
test('a malformed room name is refused, not quietly treated as a DM', async () => {
  const h = await harness();
  try {
    dao.joinRoom(h.db, '#ops', 'operator');
    dao.insertMessage(h.db, { from: 'operator', to: '#ops', body: 'one' });
    const before = countTo(h, '#ops');

    const res = await post(h, '/api/messages/clear', { target: '#Ops' }, h.origin);

    assert.equal(res.status, 400);
    // ⚠️ The STATUS alone cannot tell the branches apart — `target required`
    // is also a 400. Without this, a regression routing `#Ops` to the
    // no-target branch stays green.
    assert.match((await res.json() as { error: string }).error, /is not a valid room name/);
    assert.equal(countTo(h, '#ops'), before);
  } finally {
    close(h);
  }
});

// ── /api/claims (#101) ───────────────────────────────────────────────────

/**
 * 🛑 THE MINUTES ARE THE SERVER'S, NOT THE BROWSER'S. A tab left open
 * overnight would render ages against a stale clock, and the UI already
 * carried one copy of a bus threshold that drifted (the gauge bands, PR 113).
 */
test('a live claim is served with its holder and a server-side age', async () => {
  const h = await harness();
  const now = Date.now();
  dao.insertClaim(h.db, {
    resource: 'reset-and-test.sh',
    holder: 'peer-a',
    note: 'mode=all',
    claimed_at: now - 41 * 60_000,
    expires_at: now + 199 * 60_000,
  });

  const res = await raw(h, { path: '/api/claims' });
  const body = JSON.parse(res.body) as { claims: Array<Record<string, unknown>> };

  assert.equal(res.status, 200);
  assert.equal(body.claims.length, 1);
  assert.equal(body.claims[0]?.resource, 'reset-and-test.sh');
  assert.equal(body.claims[0]?.holder, 'peer-a');
  assert.equal(body.claims[0]?.note, 'mode=all');
  assert.equal(body.claims[0]?.held_for_minutes, 41);
  assert.equal(body.claims[0]?.expires_in_minutes, 199);
  close(h);
});

test('a released claim and an expired one are both absent', async () => {
  const h = await harness();
  const now = Date.now();

  const released = dao.insertClaim(h.db, {
    resource: 'released-thing', holder: 'peer-a', note: null, claimed_at: now - 1000, expires_at: now + 60_000,
  });
  dao.releaseClaim(h.db, released.id, now);
  dao.insertClaim(h.db, {
    resource: 'expired-thing', holder: 'peer-b', note: null, claimed_at: now - 120_000, expires_at: now - 1,
  });

  const body = JSON.parse((await raw(h, { path: '/api/claims' })).body) as { claims: unknown[] };

  // 🛑 BOTH, IN ONE TEST. Either alone would pass against a query that
  // filtered on the other condition and ignored this one.
  assert.deepEqual(body.claims, []);
  close(h);
});

test('an empty claims list is an empty array, never a missing key', async () => {
  // The panel renders "(nothing claimed)" from a length check, so a missing
  // key would throw in the browser rather than render the empty state.
  const h = await harness();

  const body = JSON.parse((await raw(h, { path: '/api/claims' })).body) as { claims: unknown[] };

  assert.deepEqual(body.claims, []);
  close(h);
});

test('a rebound GET to /api/claims is refused like every other route', async () => {
  // It is a read, but it names who is running what on this machine.
  const h = await harness();

  const res = await raw(h, { path: '/api/claims', host: 'evil.example.com' });

  assert.equal(res.status, 403);
  close(h);
});
