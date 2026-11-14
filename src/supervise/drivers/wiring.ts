import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AgentChild } from '../child.js';
import { createLineParser } from '../child.js';
import type { RateLimitSnapshot } from '../rate-limit.js';
import type { ContextSnapshot } from '../context-gauge.js';
import type { Denial } from '../denial.js';
import type { VendorSpawn } from '../vendor.js';

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
  // A PROJECTION of `VendorSpawn`, so the field TYPES are not restated here
  // and a test fake still owes four fields rather than a whole vendor.
  //
  // ⚠️ IT DOES NOT GUARD THE NEXT CAPABILITY FLAG, and an earlier version of
  // this comment claimed it did. What guards that is `AgentChild` declaring
  // the field REQUIRED: the return literal below then fails to typecheck
  // until the pass-through is added. Measured, by adding a fifth flag to both
  // contracts and omitting it here — `tsc` named this function's return.
  // Keep a new capability required on `AgentChild` and that stays true.
  vendor: Pick<VendorSpawn, 'routeEvent' | 'encodeInput' | 'reportsUsage' | 'reportsContext'>,
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
  const contextCbs: ((s: ContextSnapshot) => void)[] = [];
  const denialCbs: ((d: Denial) => void)[] = [];
  const sessionCbs: ((id: string) => void)[] = [];
  const stderrCbs: ((chunk: string) => void)[] = [];
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
      context: (snapshot) => {
        for (const cb of contextCbs) cb(snapshot);
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

  // 🛑 ATTACHED HERE, NOT PER DRIVER, so no driver can ship without it. A
  // containerized child died with its reason on this stream and nothing was
  // listening — the prelude chains on `&&` and `npm` writes its errors here,
  // so a failed install meant no agent started and no line said why.
  //
  // ⚠️ Buffered to a line break, because a chunk is not a line. `npm` emits
  // partial writes, and logging raw chunks splits one error across entries.
  child.stderr.setEncoding('utf8');
  let errBuffer = '';

  const emitErrLine = (raw: string): void => {
    const line = raw.trim();
    // An empty line carries nothing a reader needs, and a flush of pure
    // whitespace would otherwise spam one entry per write.
    if (line.length === 0) return;

    for (const cb of stderrCbs) cb(line);
  };

  // ⚠️ `\r` COUNTS AS A BREAK, NOT JUST `\n`. `npm` and `docker pull` draw
  // progress by returning the carriage without ever sending a newline, so a
  // `\n`-only split buffered the whole run and delivered it as one entry
  // thousands of characters long. Measured by claude2 on #229.
  const BREAK = /\r\n|[\n\r]/;

  child.stderr.on('data', (chunk: string) => {
    errBuffer += chunk;
    for (;;) {
      const at = errBuffer.search(BREAK);
      if (at < 0) break;

      const [sep] = BREAK.exec(errBuffer.slice(at)) ?? ['\n'];
      emitErrLine(errBuffer.slice(0, at));
      errBuffer = errBuffer.slice(at + sep.length);
    }
  });

  // 🔴 THE CASE THIS EXISTS FOR. A process that dies mid-line never sends the
  // closing break, so draining only on a break dropped the ONE line naming why
  // the container died. `end` is the only signal that no further break is
  // coming. Raised by claude2 on PR 238 with a failing repro.
  child.stderr.on('end', () => {
    const residue = errBuffer;
    errBuffer = '';
    emitErrLine(residue);
  });

  return {
    // The VENDOR's declaration, passed through. A hard-coded `true` here
    // promised a reading for a router that may never call either sink. #219.
    reportsUsage: vendor.reportsUsage,
    reportsContext: vendor.reportsContext,
    send(text: string): void {
      child.stdin.write(vendor.encodeInput(text));
    },
    onTurnEnd(cb): void {
      turnEndCbs.push(cb);
    },
    onUsage(cb): void {
      usageCbs.push(cb);
    },
    onContext(cb): void {
      contextCbs.push(cb);
    },
    onDenial(cb): void {
      denialCbs.push(cb);
    },
    onSession(cb): void {
      sessionCbs.push(cb);
      // A late subscriber must not miss an id that already arrived.
      if (lastSession) cb(lastSession);
    },
    onStderr(cb): void {
      stderrCbs.push(cb);
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
