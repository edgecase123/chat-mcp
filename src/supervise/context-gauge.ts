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
