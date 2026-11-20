import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { AgentChild } from "../child.js";
import type { VendorSpawn } from "../vendor.js";
import { attachStreams, createEventFanout } from "./fanout.js";

/**
 * Turn ONE long-lived spawned process into an `AgentChild`.
 *
 * 🛑 THIS EXISTED TWICE. The host driver and the container driver carried the
 * same callback arrays, the same line parser and the same six subscribe
 * methods, differing only in the event router and the stdin envelope — both
 * of which are now arguments. Keeping one copy is what makes a third vendor a
 * file rather than a third copy.
 *
 * 🛑 THE PROCESS OUTLIVES THE TURN HERE, AND THAT IS A VENDOR'S PROPERTY. A
 * CLI that exits after every turn needs `wirePerTurnChild` instead, because
 * `send` below writes to a stdin such a process has already closed.
 * `VendorSpawn.processPerTurn` says which, and `spawnOnHost` picks.
 */
export function wireAgentChild(
  child: ChildProcessWithoutNullStreams,
  // A PROJECTION of `VendorSpawn`, so the field TYPES are not restated here
  // and a test fake still owes four fields rather than a whole vendor.
  //
  // ⚠️ IT DOES NOT GUARD THE NEXT CAPABILITY FLAG, and an earlier version of
  // this comment claimed it did. What guards that is `AgentChild` declaring
  // the field REQUIRED: the return literal below then fails to typecheck
  // until the pass-through is added. Measured, by adding a fifth flag to both
  // contracts and omitting it here — `tsc` named this function's return.
  // Keep a new capability required on `AgentChild` and that stays true.
  vendor: Pick<
    VendorSpawn,
    "routeEvent" | "encodeInput" | "reportsUsage" | "reportsContext"
  >,
  opts: {
    /**
     * Overrides how `kill()` ends the process.
     *
     * 🛑 A CONTAINERIZED CHILD'S `docker run` CLIENT IGNORES SIGTERM. The
     * daemon only reacts to `docker stop`, which is itself SIGTERM-to-PID1
     * then SIGKILL after a grace period — so passing a `stop` here, instead
     * of leaving this to the default `child.kill()`, is what lets `--rm`
     * actually fire. Proved by `container-removal.test.ts`.
     */
    stop?: () => void;
    /**
     * Backs `AgentChild.awaitTeardown`. Omitted leaves that hook absent rather
     * than present-and-instant, because the caller distinguishes the two: a
     * driver with nothing to wait for must not claim it confirmed anything.
     */
    teardown?: () => Promise<void>;
  } = {},
): AgentChild {
  const fanout = createEventFanout(vendor);

  attachStreams(child, fanout);

  // 🛑 ONE PROCESS, SO ITS EXIT *IS* THE AGENT'S. That equivalence is the
  // whole reason this line is a pass-through rather than a policy, and it is
  // exactly what `wirePerTurnChild` cannot say.
  child.on("exit", (code, signal) => fanout.emitExit(code, signal));

  return {
    // The VENDOR's declaration, passed through. A hard-coded `true` here
    // promised a reading for a router that may never call either sink. #219.
    reportsUsage: vendor.reportsUsage,
    reportsContext: vendor.reportsContext,
    send(text: string): void {
      child.stdin.write(vendor.encodeInput(text));
    },
    ...fanout.subscriptions,
    kill(): void {
      if (opts.stop) {
        opts.stop();
        return;
      }

      child.kill();
    },
    // Spread so the key is ABSENT when no teardown was passed, rather than
    // present and undefined. `awaitTeardown?.()` cannot tell those apart, but
    // a driver test asserting the contract can.
    ...(opts.teardown ? { awaitTeardown: opts.teardown } : {}),
  };
}

/**
 * A vendor must SAY how long one of its processes lives, or the spawn fails.
 *
 * 🛑 A SEPARATE GUARD FROM `assertDeclaresCapabilities`, AND NOT AN OVERSIGHT.
 * That one takes an `AgentChild` and iterates `child[field]`, so a field
 * declared only on `VendorSpawn` is never read by it. Adding
 * `processPerTurn` to `AgentChild` instead would push a spawn strategy into
 * the contract the supervisor consumes, where nothing reads it. claude1
 * reviewing #317's plan.
 *
 * 🛑 THE TYPE SYSTEM DOES NOT COVER THIS. `tsconfig.json` includes `src/**`
 * only, so a test fake or a JavaScript driver omitting the field compiles and
 * runs — and `undefined` is falsy, which reads as a long-lived process. The
 * wiring would then write turn two into a closed pipe, and the agent would
 * simply stop answering with nothing in any log.
 */
export function assertDeclaresProcessLifetime(
  vendor: Pick<VendorSpawn, "processPerTurn">,
): void {
  if (typeof vendor.processPerTurn !== "boolean") {
    throw new Error(
      `vendor did not declare processPerTurn. A process lifetime is declared, never inferred: ` +
        `an absent field reads as undefined, which is falsy, so the supervisor would wire a ` +
        `long-lived child and write turn two to a stdin the CLI already closed. ` +
        `Set processPerTurn to true (one process per turn, like cursor-agent) or false ` +
        `(one process for many turns, like claude).`,
    );
  }
}
