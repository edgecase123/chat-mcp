import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat, writeFile, unlink, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { openDb, type Db } from '../../storage/db.js';
import { NotifyBus, notifyPeer } from '../../notify/bus.js';
import * as dao from '../../storage/dao.js';
import type { MessageKind } from '../../storage/dao.js';
import { assertRoomName } from '../../util/naming.js';
import { renderBodyToHtml } from './render.js';

const VERSION = '0.4.1';

/** Well-known path where the currently-running server writes its URL so
 *  scripts + follow-up shell commands can find it without scraping stdout.
 *  Example use: `open $(cat ~/.chat-mcp/web-url)` */
const WEB_URL_FILE = join(homedir(), '.chat-mcp', 'web-url');

/** Where the static web assets live at runtime. Ships alongside the compiled
 *  server; we assume `dist/cli/web/server.js` and `web/` are siblings under
 *  the package root. */
function assetsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/cli/web -> ../../../web
  return resolve(here, '..', '..', '..', 'web');
}

/** MIME lookup for the tiny set of file types we serve. */
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

interface ServeOptions {
  handle: string;
  port?: number;
  open?: boolean;
}

export async function runWeb(opts: ServeOptions): Promise<void> {
  const handle = opts.handle;
  const db = openDb();
  const notify = new NotifyBus(handle);
  const session_id = randomUUID();

  dao.upsertAgent(db, {
    handle,
    pid: process.pid,
    session_id,
    display_name: handle,
    metadata: { kind: 'human', ui: 'web' },
  });

  // Every connected browser tab gets its own SSE writer. When a notify fires,
  // fan out a message event to every subscriber. Tabs remove themselves from
  // the set on socket close.
  const sseClients = new Set<ServerResponse>();
  const notifyUnsub = notify.subscribe(() => {
    // Send a minimal wake event; the client re-fetches its current view via
    // /api/messages. That keeps the SSE payload cheap and lets the client
    // decide what target to sync (each tab may be looking at a different DM
    // or room).
    const frame = `event: wake\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`;
    for (const res of sseClients) {
      try { res.write(frame); } catch { /* client hung up mid-write */ }
    }
  });

  const server = createServer(async (req, res) => {
    try {
      await route(req, res, { handle, db, sseClients });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: msg }));
      }
    }
  });

  // Port selection: if --port was passed, honor it verbatim (fail if
  // taken). Otherwise try our preferred stable port first — that gives the
  // user a memorable, bookmarkable URL and lets a browser tab reconnect
  // after a restart. Fall back to an OS-assigned free port only if the
  // preferred port is taken (e.g. another chat-mcp web is already running).
  const PREFERRED_PORT = 3737;
  const actualPort = await listenWithFallback(server, opts.port, PREFERRED_PORT);
  const url = `http://127.0.0.1:${actualPort}/`;

  const banner = [
    '',
    '  ╔════════════════════════════════════════════╗',
    `  ║  chat-mcp web  ·  ${handle.padEnd(22)}    ║`,
    '  ╠════════════════════════════════════════════╣',
    `  ║  ${url.padEnd(40)}  ║`,
    '  ╚════════════════════════════════════════════╝',
    '',
    `  bound:  127.0.0.1 (localhost only)`,
    `  stop:   Ctrl-C`,
    actualPort !== PREFERRED_PORT && !opts.port
      ? `  note:   preferred port ${PREFERRED_PORT} was taken — using ${actualPort} instead`
      : null,
    '',
  ].filter((l) => l !== null).join('\n');
  console.log(banner);

  // Write URL to a well-known path so external scripts can find it.
  try {
    await mkdir(dirname(WEB_URL_FILE), { recursive: true });
    await writeFile(WEB_URL_FILE, url + '\n');
  } catch { /* best-effort */ }

  if (opts.open !== false) {
    openBrowser(url);
  }

  // Idle-shutdown: if the last SSE client disconnected and no new one joined
  // within IDLE_TIMEOUT_MS, exit. Keeps us honest about the "no persistent
  // daemon" design principle. Reset the timer whenever a client connects.
  const IDLE_TIMEOUT_MS = 60_000;
  let idleTimer: NodeJS.Timeout | null = null;
  const armIdleShutdown = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    if (sseClients.size > 0) return;
    idleTimer = setTimeout(() => {
      if (sseClients.size === 0) {
        console.log('No connected clients for 60s — exiting.');
        shutdown(0);
      }
    }, IDLE_TIMEOUT_MS);
  };
  const disarmIdleShutdown = (): void => {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  };

  // Wire the SSE client set to arm/disarm the idle timer. The `route`
  // function adds to sseClients directly; we augment via a proxy-ish set to
  // observe changes.
  const originalAdd = sseClients.add.bind(sseClients);
  const originalDelete = sseClients.delete.bind(sseClients);
  sseClients.add = (c: ServerResponse): Set<ServerResponse> => {
    const s = originalAdd(c);
    disarmIdleShutdown();
    return s;
  };
  sseClients.delete = (c: ServerResponse): boolean => {
    const ok = originalDelete(c);
    if (sseClients.size === 0) armIdleShutdown();
    return ok;
  };
  armIdleShutdown();

  const shutdown = (code: number): void => {
    notifyUnsub();
    server.close();
    void notify.close();
    try { db.close(); } catch { /* best-effort */ }
    void unlink(WEB_URL_FILE).catch(() => { /* already gone */ });
    process.exit(code);
  };
  process.on('SIGINT', () => shutdown(130));
  process.on('SIGTERM', () => shutdown(143));
}

interface RouteContext {
  handle: string;
  db: Db;
  sseClients: Set<ServerResponse>;
}

async function route(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;

  // API routes
  if (path === '/api/whoami') return handleWhoami(res, ctx);
  if (path === '/api/messages' && req.method === 'GET') return handleGetMessages(url, res, ctx);
  if (path === '/api/messages' && req.method === 'POST') return handlePostMessage(req, res, ctx);
  if (path === '/api/rooms/join' && req.method === 'POST') return handleRoomJoin(req, res, ctx);
  if (path === '/api/rooms/leave' && req.method === 'POST') return handleRoomLeave(req, res, ctx);
  if (path === '/api/events') return handleSseStream(req, res, ctx);

  // Static assets
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.statusCode = 405;
    res.end();
    return;
  }
  await serveStatic(path, res);
}

// ── API handlers ─────────────────────────────────────────────────────────

function respondJson(res: ServerResponse, body: unknown, status = 200): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  return JSON.parse(raw);
}

function handleWhoami(res: ServerResponse, ctx: RouteContext): void {
  const me = dao.getAgent(ctx.db, ctx.handle);
  const peers = dao.listAgents(ctx.db, true).filter((a) => a.handle !== ctx.handle);
  const myRooms = dao.myRooms(ctx.db, ctx.handle);
  const allRooms = dao.allRooms(ctx.db);
  const memberRoomNames = new Set(myRooms.map((r) => r.name));
  const discoverRooms = allRooms.filter((r) => !memberRoomNames.has(r.name));
  respondJson(res, {
    handle: ctx.handle,
    session_id: me?.session_id,
    peers,
    rooms: myRooms,
    discoverRooms,
    version: VERSION,
  });
}

function handleGetMessages(url: URL, res: ServerResponse, ctx: RouteContext): void {
  const target = url.searchParams.get('target');
  const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get('limit') ?? '100', 10)));
  const beforeIdRaw = url.searchParams.get('before_id');
  const beforeId = beforeIdRaw ? parseInt(beforeIdRaw, 10) : undefined;
  if (!target) return respondJson(res, { error: 'target required' }, 400);

  let rows: dao.Message[];
  if (target.startsWith('#')) {
    // Room messages: caller must be a member; DAO doesn't have a "recent
    // messages in room" helper so query directly.
    if (!dao.isRoomMember(ctx.db, target, ctx.handle)) {
      return respondJson(res, { error: 'not a member of room' }, 403);
    }
    rows = recentRoomMessages(ctx.db, target, limit, beforeId);
  } else {
    // DM between me and target peer.
    rows = recentDmMessages(ctx.db, ctx.handle, target, limit, beforeId);
  }

  respondJson(res, rows.map(hydrateForClient));
}

async function handlePostMessage(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): Promise<void> {
  const body = (await readJsonBody(req)) as { target?: string; body?: string; kind?: MessageKind };
  if (!body.target || typeof body.body !== 'string') {
    return respondJson(res, { error: 'target and body required' }, 400);
  }
  const kind: MessageKind = body.kind ?? 'chat';
  const bodyText = body.body;

  if (body.target.startsWith('#')) {
    const room = body.target;
    if (!dao.isRoomMember(ctx.db, room, ctx.handle)) {
      return respondJson(res, { error: 'not a member of room' }, 403);
    }
    const sent = dao.insertMessage(ctx.db, { from: ctx.handle, to: room, body: bodyText, kind });
    dao.advanceRoomRead(ctx.db, room, ctx.handle, sent.id);
    for (const member of dao.roomMembers(ctx.db, room)) {
      if (member === ctx.handle) continue;
      notifyPeer(member, { id: sent.id, to: room, from: ctx.handle, ts: sent.sent_at });
    }
    respondJson(res, { id: sent.id, sent_at: sent.sent_at });
  } else {
    const peer = body.target;
    if (!dao.getAgent(ctx.db, peer)) {
      return respondJson(res, { error: `unknown peer: ${peer}` }, 404);
    }
    const sent = dao.insertMessage(ctx.db, { from: ctx.handle, to: peer, body: bodyText, kind });
    notifyPeer(peer, { id: sent.id, to: peer, from: ctx.handle, ts: sent.sent_at });
    respondJson(res, { id: sent.id, sent_at: sent.sent_at });
  }
}

async function handleRoomJoin(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): Promise<void> {
  const body = (await readJsonBody(req)) as { room?: string };
  if (!body.room) return respondJson(res, { error: 'room required' }, 400);
  try { assertRoomName(body.room); }
  catch (e) { return respondJson(res, { error: (e as Error).message }, 400); }
  const result = dao.joinRoom(ctx.db, body.room, ctx.handle);
  if (result.was_new_member && result.system_message) {
    for (const member of dao.roomMembers(ctx.db, body.room)) {
      if (member === ctx.handle) continue;
      notifyPeer(member, { id: result.system_message.id, to: body.room, from: dao.SYSTEM_HANDLE, ts: result.system_message.sent_at });
    }
  }
  respondJson(res, { ok: true, was_new_member: result.was_new_member });
}

async function handleRoomLeave(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): Promise<void> {
  const body = (await readJsonBody(req)) as { room?: string };
  if (!body.room) return respondJson(res, { error: 'room required' }, 400);
  const ok = dao.leaveRoom(ctx.db, body.room, ctx.handle);
  respondJson(res, { ok });
}

function handleSseStream(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): void {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // in case anything intermediates
  res.write(`: connected\n\n`);
  ctx.sseClients.add(res);
  // Heartbeat every 20s so proxies + browsers don't drop the connection.
  const heartbeat = setInterval(() => {
    try { res.write(`: heartbeat\n\n`); } catch { /* nothing */ }
  }, 20_000);
  const close = (): void => {
    clearInterval(heartbeat);
    ctx.sseClients.delete(res);
  };
  req.on('close', close);
  req.on('error', close);
}

// ── Static asset serving ─────────────────────────────────────────────────

async function serveStatic(path: string, res: ServerResponse): Promise<void> {
  const dir = assetsDir();
  // Normalize + guard against path traversal: only serve files whose
  // resolved absolute path lives under `dir`.
  const requestedPath = path === '/' ? '/index.html' : path;
  const clean = normalize(requestedPath).replace(/^([\\/]+)/, '');
  const abs = resolve(dir, clean);
  if (!abs.startsWith(dir + '/') && abs !== dir) {
    res.statusCode = 403;
    res.end();
    return;
  }
  try {
    const s = await stat(abs);
    if (!s.isFile()) {
      res.statusCode = 404;
      res.end();
      return;
    }
    const content = await readFile(abs);
    const ext = abs.slice(abs.lastIndexOf('.'));
    res.setHeader('Content-Type', MIME[ext] ?? 'application/octet-stream');
    res.setHeader('Content-Length', content.length);
    res.setHeader('Cache-Control', 'no-cache');
    res.end(content);
  } catch {
    res.statusCode = 404;
    res.end();
  }
}

// ── DAO helpers (rows the DAO doesn't expose directly) ───────────────────

function recentRoomMessages(db: Db, room: string, limit: number, beforeId?: number): dao.Message[] {
  const args: (string | number)[] = [room];
  let where = `to_handle = ?`;
  if (beforeId !== undefined) { where += ` AND id < ?`; args.push(beforeId); }
  args.push(limit);
  const rows = db
    .prepare(`SELECT id, from_handle, to_handle, body, sent_at, delivered_at, read_at, kind FROM messages WHERE ${where} ORDER BY id DESC LIMIT ?`)
    .all(...args) as unknown as MessageRow[];
  return rows.reverse().map(toMessage);
}

function recentDmMessages(db: Db, me: string, peer: string, limit: number, beforeId?: number): dao.Message[] {
  const args: (string | number)[] = [me, peer, peer, me];
  let where = `(from_handle = ? AND to_handle = ?) OR (from_handle = ? AND to_handle = ?)`;
  if (beforeId !== undefined) { where = `(${where}) AND id < ?`; args.push(beforeId); }
  args.push(limit);
  const rows = db
    .prepare(`SELECT id, from_handle, to_handle, body, sent_at, delivered_at, read_at, kind FROM messages WHERE ${where} ORDER BY id DESC LIMIT ?`)
    .all(...args) as unknown as MessageRow[];
  return rows.reverse().map(toMessage);
}

interface MessageRow {
  id: number;
  from_handle: string;
  to_handle: string;
  body: string;
  sent_at: number;
  delivered_at: number | null;
  read_at: number | null;
  kind: MessageKind | null;
}

function toMessage(r: MessageRow): dao.Message {
  return {
    id: r.id,
    from_handle: r.from_handle,
    to_handle: r.to_handle,
    body: r.body,
    sent_at: r.sent_at,
    delivered_at: r.delivered_at,
    read_at: r.read_at,
    kind: (r.kind as MessageKind) ?? 'chat',
  };
}

/** Attach pre-rendered HTML so the client doesn't need a markdown lib. */
function hydrateForClient(m: dao.Message): dao.Message & { body_html: string } {
  return { ...m, body_html: renderBodyToHtml(m.body) };
}

// ── Browser launcher ─────────────────────────────────────────────────────

/** Try to listen on the user's --port if given, else on the preferred stable
 *  port, else on any OS-assigned free port. Returns the port actually bound. */
async function listenWithFallback(
  server: ReturnType<typeof createServer>,
  explicitPort: number | undefined,
  preferredPort: number,
): Promise<number> {
  const tryListen = (port: number): Promise<number> =>
    new Promise((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException): void => {
        server.removeListener('error', onError);
        reject(err);
      };
      server.once('error', onError);
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', onError);
        const addr = server.address();
        resolve(typeof addr === 'object' && addr ? addr.port : port);
      });
    });

  if (explicitPort !== undefined) return tryListen(explicitPort);
  try { return await tryListen(preferredPort); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
    return tryListen(0);
  }
}

function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'start'
      : 'xdg-open';
  try {
    spawn(cmd, [url], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    // Best-effort; user can always click the URL we printed.
  }
}
