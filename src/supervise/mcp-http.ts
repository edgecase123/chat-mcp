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

    const body = await readJsonBody(req);
    const sessionId = headerOf(req, 'mcp-session-id');

    if (sessionId === null) {
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

  private async openSession(
    handle: string,
    req: IncomingMessage,
    res: ServerResponse,
    body: unknown,
  ): Promise<void> {
    const server = this.opts.serverFor(handle);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        this.sessions.set(id, { handle, transport, server });
      },
      onsessionclosed: (id) => {
        this.sessions.delete(id);
      },
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  private authenticatedHandle(req: IncomingMessage): string | null {
    const header = headerOf(req, 'authorization');

    if (header === null) return null;

    const match = /^Bearer (.+)$/.exec(header);

    if (match?.[1] === undefined) return null;

    return this.opts.authenticate(match[1]);
  }
}

function headerOf(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name];

  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value[0] ?? null;

  return null;
}

/**
 * `undefined` for anything without a body, because the transport reads the
 * stream itself when nothing is passed and would then find it drained.
 */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  if (req.method !== 'POST') return undefined;

  const chunks: Buffer[] = [];

  for await (const chunk of req) chunks.push(chunk as Buffer);

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
