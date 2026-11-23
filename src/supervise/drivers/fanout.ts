import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { AgentChild } from "../child.js";
import { createLineParser } from "../child.js";
import type { RateLimitSnapshot } from "../rate-limit.js";
import type { ContextSnapshot } from "../context-gauge.js";
import type { Denial } from "../denial.js";
import type { VendorSpawn } from "../vendor.js";
import type { UnnamedToolCall } from "../child.js";

/**
 * The subscribe half of `AgentChild` — everything that is not `send`, `kill`
 * or `awaitTeardown`.
 *
 * A projection rather than a restatement, so a new callback on `AgentChild`
 * reaches both wirings without being typed twice.
 */
export type ChildSubscriptions = Pick<
  AgentChild,
  | "onTurnEnd"
  | "onUsage"
  | "onContext"
  | "onDenial"
  | "onSession"
  | "onToolCall"
  | "onStderr"
  | "onEvent"
  | "onExit"
>;

/** The vendor fields a fan-out needs. Nothing about how the CLI is spawned. */
export type FanoutVendor = Pick<VendorSpawn, "routeEvent">;

export interface EventFanout {
  /** One stdout chunk. Whole JSON lines are routed; a partial line is held. */
  feedStdout(chunk: string): void;

  /**
   * No further stdout chunk is coming — parse whatever line is still held.
   *
   * 🔴 THE ASYMMETRY WITH STDERR WAS THE BUG. Stderr flushed its residue at
   * every process end and stdout did not, so a final event written without a
   * trailing newline was held forever. Harmless for a long-lived child, fatal
   * for a per-turn one. PR 343.
   */
  flushStdout(): void;

  /** One stderr chunk. Whole lines are emitted; a partial line is held. */
  feedStderr(chunk: string): void;

  /**
   * No further line break is coming on stderr — emit whatever is buffered.
   *
   * 🔴 A process that dies mid-line never sends the closing break, so a
   * flush-on-break-only dropped the ONE line naming why a container died.
   */
  flushStderr(): void;

  emitExit(code: number | null, signal: string | null): void;

  /**
   * The id this child last reported, for a respawn's `--resume`.
   *
   * 🛑 A METHOD, NOT A SNAPSHOT FIELD. A per-turn wiring reads it when it
   * spawns the NEXT turn, which is always after the id arrived, and a value
   * captured at wiring time would be `null` forever.
   */
  lastSessionId(): string | null;

  readonly subscriptions: ChildSubscriptions;
}

// ⚠️ `\r` COUNTS AS A BREAK, NOT JUST `\n`. `npm` and `docker pull` draw
// progress by returning the carriage without ever sending a newline, so a
// `\n`-only split buffered the whole run and delivered it as one entry
// thousands of characters long. Measured by claude2 on #229.
const BREAK = /\r\n|[\n\r]/;

/**
 * The callback registry every wiring shares.
 *
 * 🛑 EXTRACTED BECAUSE THERE ARE NOW TWO PROCESS LIFETIMES, NOT TWO DRIVERS.
 * `wireAgentChild` owns one long-lived process; `wirePerTurnChild` owns one
 * process per turn and re-attaches these sinks to each. The arrays, the line
 * parser and the eight subscribe methods are identical either way, and the
 * last time this logic existed twice the two copies diverged.
 */
export function createEventFanout(vendor: FanoutVendor): EventFanout {
  const eventCbs: ((e: Record<string, unknown>) => void)[] = [];
  const turnEndCbs: (() => void)[] = [];
  const usageCbs: ((s: RateLimitSnapshot) => void)[] = [];
  const contextCbs: ((s: ContextSnapshot) => void)[] = [];
  const denialCbs: ((d: Denial) => void)[] = [];
  const sessionCbs: ((id: string) => void)[] = [];
  const toolCallCbs: ((name: string | null, why?: UnnamedToolCall) => void)[] =
    [];
  const stderrCbs: ((chunk: string) => void)[] = [];
  const exitCbs: ((code: number | null, signal: string | null) => void)[] = [];
  let lastSession: string | null = null;

  const parser = createLineParser((parsed) => {
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
      toolCall: (name, why) => {
        // ⚠️ THE `why` MUST RIDE ALONG. Dropping it here would make every
        // unnamed call read as `unknown-shape` downstream, which is the one
        // cause that may NOT soften the silent-reply warning. #417.
        for (const cb of toolCallCbs) cb(name, why);
      },
    });
  });

  let errBuffer = "";

  const emitErrLine = (raw: string): void => {
    const line = raw.trim();
    // An empty line carries nothing a reader needs, and a flush of pure
    // whitespace would otherwise spam one entry per write.
    if (line.length === 0) return;

    for (const cb of stderrCbs) cb(line);
  };

  return {
    feedStdout: (chunk: string): void => parser.feed(chunk),

    flushStdout: (): void => parser.flush(),

    feedStderr(chunk: string): void {
      errBuffer += chunk;
      for (;;) {
        const at = errBuffer.search(BREAK);
        if (at < 0) break;

        const [sep] = BREAK.exec(errBuffer.slice(at)) ?? ["\n"];
        emitErrLine(errBuffer.slice(0, at));
        errBuffer = errBuffer.slice(at + sep.length);
      }
    },

    flushStderr(): void {
      const residue = errBuffer;
      errBuffer = "";
      emitErrLine(residue);
    },

    emitExit(code, signal): void {
      for (const cb of exitCbs) cb(code, signal);
    },

    lastSessionId: (): string | null => lastSession,

    subscriptions: {
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
      onToolCall(cb): void {
        toolCallCbs.push(cb);
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
        exitCbs.push(cb);
      },
    },
  };
}

/**
 * Point one process's streams at a fan-out.
 *
 * 🛑 STDOUT AND STDERR ONLY — `exit` IS DELIBERATELY NOT WIRED HERE. The two
 * lifetimes disagree about what an exit MEANS: for a long-lived child it is
 * the agent going away, and for a per-turn child it is usually just the turn
 * finishing. Each wiring attaches `exit` with its own policy.
 *
 * ⚠️ `stderr` is attached here, not per driver, so no driver can ship without
 * it. A containerized child died with its reason on this stream and nothing
 * was listening — the prelude chains on `&&` and `npm` writes its errors
 * here, so a failed install meant no agent started and no line said why.
 */
export function attachStreams(
  child: ChildProcessWithoutNullStreams,
  fanout: EventFanout,
): void {
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => fanout.feedStdout(chunk));

  // 🔴 THE LAST LINE MAY HAVE NO NEWLINE, AND FOR A PER-TURN CHILD THAT LINE
  // IS THE TURN END. `end` is the only signal that no further chunk is
  // coming, so without this a completed turn was reported as a dead agent.
  child.stdout.on("end", () => fanout.flushStdout());

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => fanout.feedStderr(chunk));
  child.stderr.on("end", () => fanout.flushStderr());
}
