import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { BIND_ADDRESS, listenOnLoopback } from './loopback.js';
import { McpHttpService, refuse, type McpHttpOptions } from './mcp-http.js';

/** The only path served. A token is a credential for this path, not for the socket. */
const MCP_PATH = '/mcp';

/**
 * 🛑 PRE-AUTH SOCKETS ARE A HOST-WIDE RESOURCE. `host.docker.internal` reaches
 * this from EVERY container on the machine, not only ours, and the supervisor
 * holds every handle's session and its SQLite handle. `CommandBroker` caps the
 * same two halves, count and idle time.
 */
const DEFAULT_MAX_CONNECTIONS = 8;

/**
 * 🛑 A CAP WITHOUT A RECLAIM IS A LOCKOUT PRIMITIVE. A container opens every
 * slot, sends NOTHING, and the real agent is refused.
 *
 * 🛑 NODE'S OWN HTTP TIMEOUTS DO NOT CLOSE THIS. Measured on node 23: a socket
 * that connects and sends nothing survives `headersTimeout` AND `requestTimeout`
 * past 2s with both at 150/300 ms and the sweep at 75 ms. They time a REQUEST,
 * and a silent socket has not begun one. `socket.setTimeout` closed the same
 * socket in 155 ms.
 */
const DEFAULT_IDLE_TIMEOUT_MS = 10_000;

/**
 * The host-side socket `McpHttpService` deliberately does not own.
 *
 * 🛑 DO NOT MOVE THIS BIND INTO `mcp-http.ts`. That file's own 🛑 says it binds
 * nothing, and `mcp-http.test.ts` supplies its own listener as the seam that
 * proves it. Both statements stay true only while the socket lives here.
 *
 * 🛑 NO `Host` HEADER ALLOWLIST HERE, UNLIKE `cli/web/server.ts`. A container's
 * request arrives with `Host: host.docker.internal:<port>`, so an allowlist
 * built from the bound port would refuse the one caller this transport exists
 * for. The bearer token is the whole boundary.
 *
 */
export interface McpListenerOptions extends McpHttpOptions {
  /** Test seam, and an operator escape hatch. See `DEFAULT_MAX_CONNECTIONS`. */
  readonly maxConnections?: number;
  /** Idle reclaim, armed only between requests. `0` disables it. */
  readonly idleTimeoutMs?: number;
}

export class McpHttpListener {
  readonly address = BIND_ADDRESS;

  private boundPort = 0;
  /** 🛑 `close()` IS CALLED TWICE. A test closes to assert the port is free and
   * its harness closes again; the second `server.close()` throws
   * `ERR_SERVER_NOT_RUNNING`. Holding the promise makes it idempotent and makes
   * two concurrent callers wait on one shutdown. */
  private closing: Promise<void> | null = null;

  private constructor(
    private readonly server: Server,
    private readonly service: McpHttpService,
  ) {}

  static async bind(options: McpListenerOptions): Promise<McpHttpListener> {
    const server = createServer();
    const listener = new McpHttpListener(server, McpHttpService.create(options));

    server.maxConnections = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
    reclaimIdleSockets(server, options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS);

    server.on('request', (req, res) => {
      void listener.serve(req, res);
    });

    listener.boundPort = await listenOnLoopback(server);

    return listener;
  }

  get port(): number {
    return this.boundPort;
  }

  /** What piece B writes into the container's config. */
  get url(): string {
    return `http://${this.address}:${this.boundPort}${MCP_PATH}`;
  }

  /**
   * 🛑 `closeAllConnections()` OR THIS NEVER RESOLVES. `fetch` leaves a
   * keep-alive socket open, and `server.close()` waits for every one of them,
   * so the callback would not fire until the client's idle timeout.
   */
  async close(): Promise<void> {
    this.closing ??= this.shutdown();

    return this.closing;
  }

  private async shutdown(): Promise<void> {
    await this.service.close();

    const closed = new Promise<void>((resolve, reject) => {
      this.server.close((err) => (err ? reject(err) : resolve()));
    });

    this.server.closeAllConnections();

    await closed;
  }

  private async serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (pathOf(req) !== MCP_PATH) {
        // 🛑 BEFORE `handleRequest`, so an off-path `initialize` opens no
        // session. The service answers by body, not by path, so it would.
        refuse(res, 404, `no handler; this listener serves ${MCP_PATH}`);
        return;
      }

      await this.service.handleRequest(req, res);
    } catch (err) {
      // A throw out of the request handler is an unhandled rejection, which
      // takes the supervisor down with the agent's bad request.
      console.error('[mcp-listener] request failed:', err);

      if (!res.headersSent) refuse(res, 500, 'internal error');
      else res.end();
    }
  }
}

/**
 * Close a socket that holds a slot without using it.
 *
 * 🛑 ARMED ONLY WHILE NOTHING IS IN FLIGHT, THE SAME SHAPE AS `broker.ts`. The
 * transport answers over SSE, so a legitimate response is silent for as long as
 * the agent is thinking — a plain idle timeout would cut the stream it is
 * waiting on. Both halves have a test.
 */
function reclaimIdleSockets(server: Server, idleMs: number): void {
  if (idleMs <= 0) return;

  const inFlight = new WeakMap<Socket, number>();

  const arm = (socket: Socket): void => {
    if (socket.destroyed) return;

    socket.setTimeout((inFlight.get(socket) ?? 0) === 0 ? idleMs : 0);
  };

  server.on('connection', (socket) => {
    socket.on('timeout', () => socket.destroy());
    arm(socket);
  });

  server.on('request', (req, res) => {
    const { socket } = req;

    // 🛑 WHEN THE REQUEST IS FULLY RECEIVED, NOT WHEN ITS HEADERS ARE. Headers
    // arriving does not make it the server's turn — a declared body that never
    // arrives is still the caller holding the slot.
    //
    // 🛑 FROM THE HEADERS, BECAUSE `end` NEVER FIRES ON A STREAM NOBODY READS.
    // The standing SSE stream is a bodyless GET whose handler never reads it,
    // so waiting for `end` would cut it. `req.complete` is still false here —
    // the request event is emitted before the message completes. Tested both
    // ways.
    const hold = (): void => {
      inFlight.set(socket, (inFlight.get(socket) ?? 0) + 1);
      arm(socket);
    };

    if (declaresBody(req)) req.on('end', hold);
    else hold();

    res.on('close', () => {
      inFlight.set(socket, Math.max(0, (inFlight.get(socket) ?? 1) - 1));
      arm(socket);
    });
  });
}

function declaresBody(req: IncomingMessage): boolean {
  return req.headers['content-length'] !== undefined || req.headers['transfer-encoding'] !== undefined;
}

function pathOf(req: IncomingMessage): string {
  return new URL(req.url ?? '/', 'http://localhost').pathname;
}
