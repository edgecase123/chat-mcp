import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AgentChild } from '../child.js';
import { createLineParser } from '../child.js';
import type { RateLimitSnapshot } from '../rate-limit.js';
import type { Denial } from '../denial.js';
import type { EventRouter } from '../vendor.js';

/**
 * Turn a spawned process into an `AgentChild`.
 *
 * 🛑 THIS EXISTED TWICE. The host driver and the container driver carried the
 * same callback arrays, the same line parser and the same six subscribe
 * methods, differing only in the event router and the stdin envelope — both
 * of which are now arguments. Keeping one copy is what makes a third vendor a
 * file rather than a third copy.
 */
export function wireAgentChild(
  child: ChildProcessWithoutNullStreams,
  vendor: { routeEvent: EventRouter; encodeInput: (text: string) => string },
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
  const eventCbs: ((e: Record<string, unknown>) => void)[] = [];
  const turnEndCbs: (() => void)[] = [];
  const usageCbs: ((s: RateLimitSnapshot) => void)[] = [];
  const denialCbs: ((d: Denial) => void)[] = [];
  const sessionCbs: ((id: string) => void)[] = [];
  let lastSession: string | null = null;

  const feed = createLineParser((parsed) => {
    for (const cb of eventCbs) cb(parsed);

    vendor.routeEvent(parsed, {
      turnEnd: () => {
        for (const cb of turnEndCbs) cb();
      },
      usage: (snapshot) => {
        for (const cb of usageCbs) cb(snapshot);
      },
      denial: (d) => {
        for (const cb of denialCbs) cb(d);
      },
      session: (id) => {
        // Only the FIRST sighting matters; every later event repeats it.
        if (lastSession === id) return;
        lastSession = id;
        for (const cb of sessionCbs) cb(id);
      },
    });
  });

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', feed);

  return {
    reportsUsage: true,
    send(text: string): void {
      child.stdin.write(vendor.encodeInput(text));
    },
    onTurnEnd(cb): void {
      turnEndCbs.push(cb);
    },
    onUsage(cb): void {
      usageCbs.push(cb);
    },
    onDenial(cb): void {
      denialCbs.push(cb);
    },
    onSession(cb): void {
      sessionCbs.push(cb);
      // A late subscriber must not miss an id that already arrived.
      if (lastSession) cb(lastSession);
    },
    onEvent(cb): void {
      eventCbs.push(cb);
    },
    onExit(cb): void {
      child.on('exit', (code, signal) => cb(code, signal));
    },
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
