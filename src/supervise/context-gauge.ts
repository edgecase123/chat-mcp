/**
 * How full a supervised child's context window is, normalised across vendors.
 *
 * 🛑 THE DRIVER RESOLVES `total`, NOT THE SUPERVISOR. Mapping a model id to a
 * window size is vendor knowledge, like the event shapes it comes from, so it
 * belongs behind the same seam as `RateLimitSnapshot`. The supervisor writes
 * what it is handed and says when the window was a guess.
 */
export interface ContextSnapshot {
  /** Tokens the window currently holds. */
  readonly used: number;
  /** The window size `used` is measured against. */
  readonly total: number;
  /** The model id `total` was resolved from, or null if none was seen. */
  readonly model: string | null;
  /**
   * `total` is a fallback because the model id was unmapped or absent.
   *
   * ⚠️ A WRONG DENOMINATOR IS INVISIBLE IN THE PERCENTAGE. This is what lets
   * the supervisor say so once, instead of a plausible number going unread.
   */
  readonly totalIsFallback: boolean;
}

/**
 * One line for a human, saying whether a gauge reading is coming at all.
 *
 * 🛑 A BLANK GAUGE HAD TWO CAUSES AN OPERATOR COULD NOT TELL APART — a driver
 * that reports no context, and reporting that broke. Every other no-reading
 * state already logs; this was the one that could not, because nothing
 * declared the capability. #217.
 */
export function describeContextGauge(reportsContext: boolean): string {
  if (!reportsContext) {
    return 'context gauge: UNREPORTED — this driver reports no context, so the gauge stays blank';
  }

  // ⚠️ DELIBERATELY NOT "not yet observed". The rate-limit line already uses
  // that phrase, and an existing test asserts an UNMETERED driver never logs
  // it — reusing the wording made two independent gauges indistinguishable in
  // the log and broke that test.
  return 'context gauge: reported by this driver; awaiting the first reading';
}
