import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createServer, type Server } from 'node:http';
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
  const ctx: RouteContext = { handle, db, sseClients: new Set() };
  const server = createServer((req, res) => { void route(req, res, ctx); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return { db, server, origin: `http://127.0.0.1:${port}` };
}

function close(h: Harness): void {
  // ⚠️ close() alone leaves fetch's keep-alive sockets open and the test
  // runner never exits. Measured: the file hung past an 8s per-test timeout.
  h.server.closeAllConnections();
  h.server.close();
  h.db.close();
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
