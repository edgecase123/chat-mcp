import { buildServer, shimContextFor } from "../shim/index.js";
import * as dao from "../storage/dao.js";
import type { BusEndpoint } from "./child.js";
import { authenticateToken, mintToken, revokeToken } from "./handle-tokens.js";
import { McpHttpListener } from "./mcp-listener.js";

export interface HostBus {
  /** What the child is configured with. */
  readonly endpoint: BusEndpoint;
  close(): Promise<void>;
}

/**
 * Give the child a bus row before it has run, reading as OFFLINE.
 *
 * 🛑 A HOST CHILD REGISTERS AT PROCESS START AND A CONTAINERIZED ONE DID NOT
 * REGISTER AT ALL. The host path runs the shim as its own process. A container
 * reaches `shimContextFor` only through `serverFor`, which needs a SESSION, and
 * `cursor-agent` opens one lazily on its first chat tool call — so a turn that
 * needed only `Read` left no row and the sidebar row was never clickable.
 *
 * 🛑 `shimContextFor` RATHER THAN A HAND-BUILT UPSERT. Its own docblock records
 * why: the host bus once built the other four fields by hand and missed the
 * registration. Two copies of a five-step construction is how a step goes
 * missing.
 *
 * 🛑 THEN NULL THE PID, WHICH IS THE WHOLE REASON THIS IS SAFE. The pid written
 * is `process.pid` — the SUPERVISOR's, not the child's — so leaving it would
 * make a child that never starts read as online and route a sibling's work to
 * nothing. `dao.clearAgentPid`'s docblock prescribes exactly this.
 *
 * ⚠️ THE CONTEXT IS TRANSIENT ON PURPOSE. The ROW persists in sqlite; nothing
 * long-lived is held here, so `serverFor` keeps sole ownership of session
 * teardown and there is no second handle for anyone to close.
 *
 * 🛑 THE NULL IS CHECKED AND THROWS, BECAUSE DISCARDING IT FAILS OPEN INTO THE
 * PHANTOM THIS FUNCTION EXISTS TO PREVENT. `clearAgentPid` reports whether it
 * matched a row. The teardown call sites only LOG a false, which is right for
 * them — a row already gone is the outcome they wanted. Here the row was
 * written one statement earlier, so a false means the write did not land and
 * continuing leaves the supervisor's pid on a handle that reads ONLINE.
 */
async function registerChildOffline(childHandle: string): Promise<void> {
  const ctx = shimContextFor({
    handle: childHandle,
    sandbox: "docker",
    adapterStatus: { installed: true, framework: null, hint: null },
    force: true,
  });

  try {
    if (!dao.clearAgentPid(ctx.db, childHandle)) {
      throw new Error(
        `registered ${childHandle} and then could not null its pid, so the ` +
          `handle would read ONLINE with the supervisor's pid and a sibling ` +
          `would route work to a child that has not started`,
      );
    }
  } finally {
    await ctx.notify.close();
    ctx.db.close();
  }
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
  const listener = await McpHttpListener.bind({
    authenticate: authenticateToken,

    serverFor: (handle: string) => {
      const ctx = shimContextFor({
        handle,

        // 🛑 DERIVED, NOT ASSUMED. `startSupervisor` opens this listener only
        // under `isContainerSpawn`, and the docblock above says a container has
        // no other route to the bus. So every session served here is a
        // containerized one, and `run_command` is refused for it.
        sandbox: "docker",

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

      // 🛑 THE SERVICE OWNS THE TEARDOWN, NOT THIS. It is the only side that
      // learns when a session ended, so handing it the release is what stops a
      // serial initialize → DELETE loop growing a handle and a poller per lap.
      return {
        server: buildServer(ctx),
        close: async () => {
          await ctx.notify.close();
          ctx.db.close();
        },
      };
    },
  });

  // 🛑 AFTER the bind, so a listener that failed to bind leaves no row behind.
  await registerChildOffline(childHandle);

  return {
    endpoint: { url: listener.url, token: mintToken(childHandle) },

    // 🛑 THE CREDENTIAL TOO, NOT JUST THE SOCKET. The container runs with
    // `--rm`, so it is gone, but its token was minted on disk and
    // `authenticateToken` reads it from there — it stayed valid against every
    // listener opened afterwards.
    //
    // 🛑 SAFE ONLY BECAUSE OF WHEN THIS RUNS. `supervise/index.ts` kills the
    // child and awaits its teardown before closing the bus, so revoking here
    // cannot race a live child's own credential.
    close: async (): Promise<void> => {
      await listener.close();
      revokeToken(childHandle);
    },
  };
}
