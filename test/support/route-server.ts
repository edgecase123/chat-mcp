import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

/**
 * One listening HTTP server for a web-route test, wrapping `route` in the SAME
 * catch production uses — #426.
 *
 * 🛑 A BARE `void route(req, res, ctx)` KILLS THE TEST PROCESS. `route` is
 * async, so a throw is an unhandled rejection: Node reports a FILE-level
 * failure with no assertion and no stack, and every test after it in that file
 * never runs. A real route defect then reads as a broken runner.
 *
 * 🛑 `route` IS AN ARGUMENT, NOT AN IMPORT, AND MUST STAY ONE. Callers set
 * `CHAT_MCP_HOME` to a tmpdir and only then `await import` the server, because
 * `registrations.ts` and `container.ts` resolve state paths at import time. A
 * static import here would pin the operator's real files for every caller.
 *
 * 🛑 THE CATCH DOES NOT SWALLOW. It answers the 500 a browser really receives,
 * carrying the message, so the asserting test fails loudly on the status it
 * did not expect instead of the process dying.
 */
export type RouteFn<C> = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: C,
) => Promise<void>;

export interface RouteServer {
  readonly server: Server;
  readonly origin: string;
  readonly port: number;
  /** Drops live connections first, so a kept-alive fetch cannot hold the suite open. */
  readonly close: () => void;
}

export async function listenWithRoute<C>(
  route: RouteFn<C>,
  ctx: C,
): Promise<RouteServer> {
  const server = createServer((req, res) => {
    void route(req, res, ctx).catch((err: unknown) => {
      // 🛑 COERCE, NEVER CAST. `(err as Error).message` is `undefined` for a
      // thrown string and THROWS for a thrown null — a second throw inside the
      // catch, which is this ticket's own defect one frame along. This is
      // production's line from `server.ts:190`, character for character.
      const msg = err instanceof Error ? err.message : String(err);
      // Production's guard: a route that already started writing cannot be
      // handed a status, and setting one would throw a second time.
      if (res.headersSent) return;
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: msg }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    server,
    port,
    origin: `http://127.0.0.1:${port}`,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}
