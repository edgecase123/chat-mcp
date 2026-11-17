import { readFileSync } from "node:fs";
import { join } from "node:path";

import { stateDir as defaultStateDir } from "../util/paths.js";
import { COOKIE_NAME, HANDSHAKE_PARAM } from "../cli/web/credential.js";

/**
 * Telling the web UI that a supervised agent is WORKING, #240.
 *
 * 🛑 THE SUPERVISOR IS THE HTTP CLIENT, AND THE DIRECTION IS THE DESIGN. lee,
 * 2026-11-14: *"when one of the supervisors connections emits a stdout event,
 * have it hit a special /activity/<handle> route"*. The reverse — the web
 * server holding a connection per supervisor — needs discovery and reconnect
 * logic, because there is one supervisor PROCESS per handle. As a client each
 * supervisor needs no state and the web server needs no knowledge of who
 * exists.
 *
 * 🛑 NO POLLING ANYWHERE ON THIS PATH. lee, 2026-11-14: *"I don't want more
 * polling. We really shouldn't have any polling, IMO. Everything should be
 * event based."* Two earlier designs added one and were dropped.
 */

/**
 * The smallest gap between two ticks that reaches the network.
 *
 * ⚠️ 250ms CAPS THE POSTS AT FOUR A SECOND. The dot is binary — it pulses or
 * it does not — so a finer rate buys nothing a viewer can see and costs a
 * request per tool call on the supervisor's hot path.
 */
export const ACTIVITY_THROTTLE_MS = 250;

/**
 * How long a pulse survives with no further word, when nothing ends it.
 *
 * 🛑 30 SECONDS, AND IT IS A FAILSAFE RATHER THAN A DECAY. An earlier sketch
 * decayed the pulse after 2s, which goes DARK MID-TURN: a single long `Bash`
 * emits no stream event for its whole duration, so the dot would stop while
 * the agent was genuinely working. Turn-end clears the pulse now, so this only
 * has to outlast a child that dies without saying so.
 */
export const PULSE_FAILSAFE_MS = 30_000;

/** What the supervisor is announcing about a turn. */
export type ActivityPhase = "tick" | "end";

/** Where to post, and the credential to post with. */
export interface ActivityTarget {
  origin: string;
  token: string;
}

/**
 * The running web server's origin and token, or `null` when none is up.
 *
 * 🛑 `web-handshake` IS A URL WITH THE TOKEN IN A QUERY PARAM, NOT A TOKEN.
 * `server.ts` builds `handshakeUrl` and writes it to `webHandshakeFile()`.
 * Sending the file's contents as the cookie value 401s every pulse:
 * `tokenMatches` compares lengths first, 68 against 43. Found by claude1 on
 * PR 244, and the fixtures hid it by writing a bare token no producer emits.
 *
 * 🛑 THE EXISTENCE CHECK IS THE OTHER HALF. The web server is DOWN most of the
 * time — `server.ts` arms a 60-second idle shutdown at boot and exits once no
 * browser holds an SSE stream. Attempting a POST per stream event against a
 * closed port is what would fill a supervisor log with refusals, so the cheap
 * answer is to not attempt one.
 *
 * ⚠️ `web-url` IS NOT READ, AND IT IS NOT AN OVERSIGHT. It is the tokenless
 * twin, so it can never produce a usable target — the handshake url carries
 * the origin as well as the credential.
 */
export function activityTarget(
  dir: string = defaultStateDir(),
): ActivityTarget | null {
  const read = (name: string): string | null => {
    try {
      const raw = readFileSync(join(dir, name), "utf8").trim();

      return raw.length > 0 ? raw : null;
    } catch {
      // Absent, unreadable, or the directory is gone. All mean "no server".
      return null;
    }
  };

  const handshake = read("web-handshake");

  if (handshake === null) return null;

  try {
    const parsed = new URL(handshake);
    const token = parsed.searchParams.get(HANDSHAKE_PARAM);

    if (token === null || token.length === 0) return null;

    return { origin: parsed.origin, token };
  } catch {
    // A truncated url file — a server mid-write, or killed between open and
    // write. Not a target, and not worth a word.
    return null;
  }
}

export interface ActivityReporterOptions {
  /**
   * The supervised agent this reporter speaks for.
   *
   * 🛑 A THUNK IS ACCEPTED BECAUSE `index.ts` PASSES `childBusHandle`, WHICH
   * CARRIES A READ-IT-DO-NOT-CACHE RULE. Following that rule is the whole
   * reason, and it costs one `typeof` per pulse.
   *
   * ⚠️ THE HANDLE IS CONSTANT TODAY, so this guards nothing yet. An earlier
   * version of this comment claimed `currentGrant` is reassigned with a new
   * handle; it is reassigned once, by a spread that carries `handle` through
   * untouched. Raised by claude1 on PR 244, who had endorsed the wrong
   * mechanism first.
   */
  handle: string | (() => string);
  /** Overridable for tests. */
  stateDir?: () => string;
  /** Overridable for tests, so the throttle window can be stepped. */
  now?: () => number;
}

/**
 * A function that tells the web UI this agent is working.
 *
 * 🛑 NEVER AWAIT WHAT THIS RETURNS — it returns nothing on purpose. The caller
 * is `onEvent`, which runs while draining the child's stdout, so an awaited
 * request would add latency per event. `notifyPeer` stays synchronous for the
 * same reason and says so at its own call site.
 *
 * ⚠️ ONE REPORTER PER HANDLE. A shared throttle window would let a busy agent
 * hide a quiet one's dot.
 */
export function createActivityReporter(
  opts: ActivityReporterOptions,
): (phase: ActivityPhase) => void {
  const dirOf = opts.stateDir ?? defaultStateDir;
  const clock = opts.now ?? Date.now;
  let lastTickAt = Number.NEGATIVE_INFINITY;

  return (phase: ActivityPhase): void => {
    // 🛑 AN `end` IS NEVER THROTTLED. It is the signal that CLEARS the pulse,
    // so dropping one because a tick just went out leaves the dot pulsing
    // until the failsafe — which reads as an agent that never finished.
    if (phase === "tick") {
      const at = clock();

      if (at - lastTickAt < ACTIVITY_THROTTLE_MS) return;

      lastTickAt = at;
    }

    const target = activityTarget(dirOf());

    if (target === null) return;

    const handle =
      typeof opts.handle === "string" ? opts.handle : opts.handle();
    const body = JSON.stringify({ handle, phase });

    // Fire and forget. `void` is the contract: nothing upstream may wait.
    void fetch(`${target.origin}/api/activity`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // The supervisor has no cookie jar, so it presents the credential the
        // browser would have been handed at the handshake.
        //
        // 🛑 IMPORTED, NEVER SPELLED OUT HERE. A hand-written copy of this
        // name was wrong on the first cut — `chat_mcp_web` against the real
        // `chat_mcp_api` — and every POST would have 401'd while the module
        // looked correct. A test asserting the TOKEN appears in the header
        // passes under either name, so only the shared constant closes it.
        cookie: `${COOKIE_NAME}=${target.token}`,
      },
      body,
    }).then(
      () => undefined,
      () => {
        // 🛑 SWALLOWED, AND THERE IS NO OPTION TO DO OTHERWISE. Refused, reset
        // and timed out are all the NORMAL state — the web server exits after
        // 60 idle seconds — so a line here is one log entry per tool call
        // forever. A first cut had a `log` hook and its own test proved the
        // hook WAS the flood this layer exists to avoid.
        undefined;
      },
    );
  };
}
