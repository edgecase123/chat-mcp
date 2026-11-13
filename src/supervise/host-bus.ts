import { buildServer, shimContextFor, type ShimContext } from '../shim/index.js';
import type { BusEndpoint } from './child.js';
import { authenticateToken, mintToken } from './handle-tokens.js';
import { McpHttpListener } from './mcp-listener.js';

export interface HostBus {
  /** What the child is configured with. */
  readonly endpoint: BusEndpoint;
  close(): Promise<void>;
}

/**
 * The host's MCP listener, opened for ONE containerized child.
 *
 * 🛑 THIS IS THE PRODUCER `dockerRunPlan` REFUSES TO RUN WITHOUT. A container
 * has no other route to the bus since the state-dir mount was deleted — it is
 * not a second process on `chat.db` any more, it is an HTTP client of this.
 *
 * 🛑 MINTING REPLACES THE HANDLE'S PREVIOUS TOKEN, WHICH IS WHAT A RESTART
 * NEEDS. The container that held the old one is gone with `--rm`.
 */
export async function openHostBus(childHandle: string): Promise<HostBus> {
  const open: ShimContext[] = [];

  const listener = await McpHttpListener.bind({
    authenticate: authenticateToken,

    serverFor: (handle: string) => {
      const ctx = shimContextFor({
        handle,

        // 🛑 NOT `checkWakeAdapter(handle)`. That reports whether a HOST wake
        // adapter is installed, and a supervised child is woken by the
        // supervisor writing to its stdin. Reporting the host's answer here
        // would tell a correctly-woken agent its wake path is broken.
        adapterStatus: { installed: true, framework: null, hint: null },

        // 🛑 THE INCUMBENT IS THIS SAME SUPERVISOR. A restarted child re-claims
        // its handle from a row whose pid is still alive — ours — so the
        // liveness guard would refuse every restart. The same reason minting
        // replaces the handle's previous token.
        force: true,
      });

      open.push(ctx);

      return buildServer(ctx);
    },
  });

  return {
    endpoint: { url: listener.url, token: mintToken(childHandle) },

    // 🛑 THE CONTEXTS TOO, NOT JUST THE SOCKET. Each session opened a database
    // handle and a NotifyBus, and closing the listener releases neither.
    close: async (): Promise<void> => {
      await listener.close();

      for (const ctx of open) {
        await ctx.notify.close();
        ctx.db.close();
      }
    },
  };
}
