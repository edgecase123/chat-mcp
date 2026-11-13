import type { AddressInfo, Server } from 'node:net';

/**
 * 🛑 LOOPBACK IS NOT THE BOUNDARY. A container reaches a host `127.0.0.1` bind
 * through `host.docker.internal` on Docker Desktop, measured. The token is what
 * separates callers; this only keeps a host listener off the operator's LAN.
 *
 * Extracted rather than copied, so the warning above cannot drift between the
 * two host listeners that share it — `CommandBroker` and `McpHttpListener`.
 */
export const BIND_ADDRESS = '127.0.0.1';

/**
 * Bind `server` to an OS-assigned loopback port and resolve the port it got.
 *
 * 🛑 THE `error` LISTENER IS REMOVED ON SUCCESS. Left attached, a later
 * runtime error on the socket would reject a promise that has already
 * resolved, which is silent rather than reported.
 *
 * Typed on `net.Server`, which `http.Server` extends, so the two host
 * listeners share one implementation instead of each writing this dance.
 */
export async function listenOnLoopback(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, BIND_ADDRESS, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  return (server.address() as AddressInfo).port;
}
