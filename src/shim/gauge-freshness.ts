/**
 * Whether a stored context reading still describes the agent.
 *
 * 🛑 THIS EXISTS BECAUSE A FROZEN GAUGE IS INDISTINGUISHABLE FROM A LIVE ONE.
 * Measured 2026-11-04: `claude1` and `claude2` both reported `1000000/1000000`
 * — exactly 100% — and the last report was **27.7 days old**. The hook feeding
 * them had not run since 7 October. Nothing surfaced that, because
 * `list_agents` and `whoami` emitted `context_reported_at` raw and no reader
 * ever subtracted it from now.
 *
 * Both agents spent a working day treating that 100% as current, and told each
 * other to act on it. See #103 and #108.
 */

/**
 * How old a reading may be before it stops being evidence.
 *
 * 🛑 NOT A ROUND NUMBER FOR ITS OWN SAKE. The feeding hook fires on every tool
 * call, so a working agent refreshes this many times a minute. Fifteen minutes
 * of silence therefore means the agent is idle, gone, or unfed — and in all
 * three the last number has stopped describing anything.
 *
 * Too short and a thinking pause reads as a failure. Too long and this becomes
 * the bug it was written to catch.
 */
export const GAUGE_STALE_AFTER_MS = 15 * 60 * 1000;

export interface GaugeFreshness {
  /** False when the reading is too old to act on, or there is none. */
  fresh: boolean;
  /** Milliseconds since the reading, or null when none was ever taken. */
  age_ms: number | null;
}

/**
 * 🛑 "NEVER REPORTED" AND "REPORTED LONG AGO" BOTH RESOLVE TO NOT-FRESH, and
 * they are kept distinct in `age_ms`. A reader that only sees `fresh: false`
 * still behaves correctly; one that wants to say *why* can.
 *
 * `now` is an argument so this is testable without mocking the clock.
 */
export function gaugeFreshness(
  reportedAt: number | null | undefined,
  now: number,
  staleAfterMs: number = GAUGE_STALE_AFTER_MS,
): GaugeFreshness {
  if (reportedAt === null || reportedAt === undefined) {
    return { fresh: false, age_ms: null };
  }

  // A reading from the future is a clock disagreement, not freshness. Clamp to
  // zero so it reads as "just now" rather than as a negative age.
  const age = Math.max(0, now - reportedAt);

  return { fresh: age <= staleAfterMs, age_ms: age };
}
