import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

export interface McpHttpOptions {
  /**
   * 🛑 THE CALLER'S IDENTITY COMES FROM ITS SECRET, NEVER FROM A FIELD IT
   * FILLS IN. Return the handle a token belongs to, or null to refuse.
   *
   * Injected rather than implemented here, so this and `CommandBroker` share
   * one comparison instead of each writing their own. Production passes
   * `authenticateToken` from `handle-tokens.ts`.
   */
  readonly authenticate: (token: string) => string | null;

  /**
   * Build the server a freshly authenticated handle gets.
   *
   * 🛑 ONE INSTANCE PER SESSION. Sharing one `McpServer` across two transports
   * throws `Already connected to a transport` and takes the process with it —
   * pinned by `🛑 ONE handle with TWO sessions gets TWO servers`.
   */
  readonly serverFor: (handle: string) => McpServer;
}

interface Session {
  readonly handle: string;
  readonly transport: StreamableHTTPServerTransport;
  readonly server: McpServer;
}

/**
 * Serves `buildServer(ctx)` over Streamable HTTP, one server per session.
 *
 * 🛑 THIS BINDS NOTHING AND MUST NOT. A bound listener reaching `main` without
 * authentication is reachable from ANY container on the machine through
 * `host.docker.internal` — measured on Docker Desktop, and `broker.ts` carries
 * the same warning. The caller owns the socket and hands requests in.
 *
 * 🛑 EVERY REQUEST RE-AUTHENTICATES. A session id is a routing key, never a
 * credential — pinned by `🛑 a known session id with NO token is refused`.
 */
export class McpHttpService {
  private readonly sessions = new Map<string, Session>();

  private constructor(private readonly opts: McpHttpOptions) {}

  static create(opts: McpHttpOptions): McpHttpService {
    return new McpHttpService(opts);
  }

  async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const handle = this.authenticatedHandle(req);

    if (handle === null) {
      refuse(res, 401, 'unauthorized', { 'www-authenticate': 'Bearer' });
      return;
    }

    let body: unknown;

    try {
      body = await readJsonBody(req);
    } catch (err) {
      if (!(err instanceof BodyTooLarge)) throw err;

      // 🛑 DRAIN, DO NOT DESTROY. Destroying the socket here reached the caller
      // as ECONNRESET rather than as the 413, so the refusal it is meant to
      // read never arrived. Nothing is buffered past the cap either way.
      req.resume();
      refuse(res, 413, 'request body too large', { connection: 'close' });
      return;
    }

    const sessionId = headerOf(req, 'mcp-session-id');

    if (sessionId === null) {
      // 🛑 REFUSE BEFORE BUILDING. `serverFor` opens a database handle and a
      // NotifyBus, so building one for a request that cannot open a session
      // let an authenticated caller spend the host's descriptors at will.
      if (!isInitialize(body)) {
        refuse(res, 400, 'no session, and this is not an initialize request');
        return;
      }

      await this.openSession(handle, req, res, body);
      return;
    }

    const session = this.sessions.get(sessionId);

    if (session === undefined) {
      refuse(res, 404, 'no such session');
      return;
    }

    // 🛑 THE HOLE MY OWN PROBE HAD. It resolved the session once the token was
    // valid, so a valid token for any handle drove any live session.
    if (session.handle !== handle) {
      refuse(res, 403, 'this session belongs to another handle');
      return;
    }

    await session.transport.handleRequest(req, res, body);
  }

  async close(): Promise<void> {
    const open = [...this.sessions.values()];

    this.sessions.clear();

    for (const session of open) {
      await session.server.close();
    }
  }

  /**
   * 🛑 A SERVER THAT OPENED NO SESSION IS CLOSED BEFORE THIS RETURNS. Only an
   * `initialize` reaches `onsessioninitialized`, so every other request left an
   * `McpServer` connected to a transport and absent from `sessions` — and
   * `close()` iterates `sessions`, so it never reached them. An authenticated
   * caller exhausted the host's file descriptors without opening a session.
   *
   * The `finally` covers the throwing path too, where `handleRequest` raises
   * after `connect` succeeded. Pinned by `🛑 a request that opens NO session
   * leaves NO server behind`.
   */
  private async openSession(
    handle: string,
    req: IncomingMessage,
    res: ServerResponse,
    body: unknown,
  ): Promise<void> {
    const server = this.opts.serverFor(handle);
    const opened: string[] = [];

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        opened.push(id);
        this.sessions.set(id, { handle, transport, server });
      },
      onsessionclosed: (id) => {
        this.sessions.delete(id);
      },
    });

    await server.connect(transport);

    try {
      await transport.handleRequest(req, res, body);
    } finally {
      if (opened.length === 0) await server.close();
    }
  }

  private authenticatedHandle(req: IncomingMessage): string | null {
    const header = headerOf(req, 'authorization');

    if (header === null) return null;

    const match = /^Bearer (.+)$/.exec(header);

    if (match?.[1] === undefined) return null;

    return this.opts.authenticate(match[1]);
  }
}

/**
 * Whether this body would open a session. A batch counts if any member does,
 * matching the transport, which initializes on the first `initialize` it sees.
 */
function isInitialize(body: unknown): boolean {
  const one = (m: unknown): boolean =>
    typeof m === 'object' && m !== null && (m as { method?: unknown }).method === 'initialize';

  return Array.isArray(body) ? body.some(one) : one(body);
}

function headerOf(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name];

  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value[0] ?? null;

  return null;
}

/**
 * 🛑 THE BODY IS CAPPED, BECAUSE IT IS BUFFERED WHOLE BEFORE ANYTHING READS IT.
 * The container is the untrusted party in this transport, and an uncapped read
 * meant a junk body was held in memory in full and only then refused.
 * Pinned by `🛑 a body over the cap is refused 413`.
 */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** Thrown past the cap, so the caller answers 413 rather than buffering on. */
class BodyTooLarge extends Error {}

/**
 * 🛑 THE DECLARED LENGTH IS CHECKED BEFORE A BYTE IS READ, AND THAT IS WHAT
 * MAKES THE 413 DETERMINISTIC. Refusing part-way through the upload raced the
 * client, which read ECONNRESET instead of the 413 about one run in two. A
 * chunked body declares no length, so the streaming cap below still backs this
 * up — and a reset is the honest answer there.
 */
function declaredLengthOver(req: IncomingMessage, cap: number): boolean {
  const header = headerOf(req, 'content-length');

  if (header === null) return false;

  const declared = Number(header);

  return Number.isFinite(declared) && declared > cap;
}

/**
 * `undefined` for anything without a body, because the transport reads the
 * stream itself when nothing is passed and would then find it drained.
 */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  if (req.method !== 'POST') return undefined;

  if (declaredLengthOver(req, MAX_BODY_BYTES)) {
    throw new BodyTooLarge(`content-length exceeds ${MAX_BODY_BYTES} bytes`);
  }

  const chunks: Buffer[] = [];
  let bytes = 0;

  for await (const chunk of req) {
    bytes += (chunk as Buffer).length;

    if (bytes > MAX_BODY_BYTES) throw new BodyTooLarge(`body exceeds ${MAX_BODY_BYTES} bytes`);

    chunks.push(chunk as Buffer);
  }

  const raw = Buffer.concat(chunks).toString('utf8');

  if (raw.length === 0) return undefined;

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function refuse(
  res: ServerResponse,
  status: number,
  message: string,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(
    JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message }, id: null }),
  );
}
