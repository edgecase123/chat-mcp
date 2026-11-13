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
 * slot and the real agent is refused.
 *
 * 🛑 AN ABSOLUTE DEADLINE, NOT AN IDLE ONE, AND THE DIFFERENCE IS THE WHOLE
 * GUARD. An inactivity timer is reset by one byte, so a caller dribbling a
 * declared body holds a slot forever — measured at a byte every 50 ms against
 * a 300 ms timer, alive past 3s. This bounds the time from connect to a FULLY
 * RECEIVED request instead, so a trickle cannot extend it.
 *
 * 🛑 NODE'S OWN HTTP TIMEOUTS DO NOT CLOSE ANY OF IT. Measured on node 23: a
 * socket that connects and sends nothing survives `headersTimeout` AND
 * `requestTimeout` past 2s with both at 150/300 ms and the sweep at 75 ms.
 */
const DEFAULT_RECEIVE_TIMEOUT_MS = 10_000;

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
 */
export interface McpListenerOptions extends McpHttpOptions {
  /** Test seam, and an operator escape hatch. See `DEFAULT_MAX_CONNECTIONS`. */
  readonly maxConnections?: number;
  /** How long a caller may take to deliver a request. `0` disables it. */
  readonly receiveTimeoutMs?: number;
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
    reclaimIdleSockets(server, options.receiveTimeoutMs ?? DEFAULT_RECEIVE_TIMEOUT_MS);

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
 * Close a socket that holds a slot without delivering a request.
 *
 * 🛑 ARMED WHILE THE CALLER OWES US BYTES, AND ONLY THEN. The transport answers
 * over SSE, so a response is silent for as long as the agent is thinking — a
 * deadline that kept running would cut the stream the caller is waiting on.
 * Disarming on a FULLY RECEIVED request is what separates the two. Both halves
 * have a test.
 */
function reclaimIdleSockets(server: Server, receiveMs: number): void {
  if (receiveMs <= 0) return;

  const deadlines = new WeakMap<Socket, NodeJS.Timeout>();

  const arm = (socket: Socket): void => {
    if (socket.destroyed) return;

    clearTimeout(deadlines.get(socket));
    deadlines.set(
      socket,
      setTimeout(() => socket.destroy(), receiveMs).unref(),
    );
  };

  const disarm = (socket: Socket): void => {
    clearTimeout(deadlines.get(socket));
    deadlines.delete(socket);
  };

  server.on('connection', (socket) => {
    socket.on('close', () => disarm(socket));
    arm(socket);
  });

  server.on('request', (req, res) => {
    const { socket } = req;

    // 🛑 NOT RE-ARMED HERE. The clock runs from the connection, or from the end
    // of the last response, so headers arriving buys the caller no extra time.
    //
    // 🛑 `end` NEVER FIRES ON A STREAM NOBODY READS, so a bodyless request is
    // recognised from its headers. The standing SSE stream is a GET whose
    // handler never reads it, and waiting for `end` would cut it.
    if (declaresBody(req)) req.on('end', () => disarm(socket));
    else disarm(socket);

    res.on('close', () => arm(socket));
  });
}

function declaresBody(req: IncomingMessage): boolean {
  return req.headers['content-length'] !== undefined || req.headers['transfer-encoding'] !== undefined;
}

function pathOf(req: IncomingMessage): string {
  return new URL(req.url ?? '/', 'http://localhost').pathname;
}
