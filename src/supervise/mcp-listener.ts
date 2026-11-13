import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { BIND_ADDRESS } from './loopback.js';
import { McpHttpService, type McpHttpOptions } from './mcp-http.js';

/** The only path served. A token is a credential for this path, not for the socket. */
const MCP_PATH = '/mcp';

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
 * ⚠️ NO CONNECTION OR IDLE LIMITS YET, where `CommandBroker` has both. Same
 * threat model, so this is a gap rather than a decision.
 */
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

  static async bind(options: McpHttpOptions): Promise<McpHttpListener> {
    const server = createServer();
    const listener = new McpHttpListener(server, McpHttpService.create(options));

    server.on('request', (req, res) => {
      void listener.serve(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, BIND_ADDRESS, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });

    listener.boundPort = (server.address() as AddressInfo).port;

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

function pathOf(req: IncomingMessage): string {
  return new URL(req.url ?? '/', 'http://localhost').pathname;
}

function refuse(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message }, id: null }));
}
