/**
 * Pure state-machine for the context-gauge threshold warnings.
 *
 * The gauge has three warning bands:
 *   soft  (yellow) — used ≥ 70% of total. DM to the peer only.
 *   warn  (orange) — used ≥ 85%. Room-post visible to co-agents + human.
 *   crit  (red)    — used ≥ 95%. Room-post with kind='alert'.
 *
 * Hysteresis of 5% under each band prevents chatter when the peer sits
 * right at the boundary. Down-transitions only step one band at a time.
 *
 * The state is stored per-peer as `context_warned_threshold` (nullable
 * INTEGER, one of 70 | 85 | 95). A fresh peer is null; on the way up we
 * warn once as we enter each band; on the way down we downshift silently.
 */

export const BANDS = [
  { warn: 70, reset: 65 },
  { warn: 85, reset: 80 },
  { warn: 95, reset: 90 },
] as const;

export type Threshold = 70 | 85 | 95;

export interface GaugeTransition {
  /** New value to persist to context_warned_threshold. */
  next_warned: Threshold | null;
  /**
   * The band we just newly entered on the way up. `null` if this report
   * didn't cross any threshold (either no change, or a step-down). At
   * most one fire per report — a large jump straight to critical only
   * fires 95, not 70+85+95.
   */
  fire: Threshold | null;
}

/**
 * Compute the state transition for a single context report.
 *
 * @param percent — new percent (0..100), typically Math.round((used/total)*1000)/10
 * @param prevWarned — value currently in context_warned_threshold
 */
export function nextGaugeState(percent: number, prevWarned: Threshold | null): GaugeTransition {
  // Step up: find the highest band we've newly entered.
  let next: Threshold | null = prevWarned;
  let fire: Threshold | null = null;
  for (const band of BANDS) {
    if (percent >= band.warn && (next == null || next < band.warn)) {
      // Newly crossed this band's warn line.
      fire = band.warn as Threshold;
      next = band.warn as Threshold;
    }
  }
  // At most one fire per call: `fire` holds the highest one crossed.

  // Step down (hysteresis, no fire): one band at a time.
  if (fire == null) {
    if (next === 95 && percent < 90) next = 85;
    if (next === 85 && percent < 80) next = 70;
    if (next === 70 && percent < 65) next = null;
  }

  return { next_warned: next, fire };
}

/**
 * Body copy for a warning at each level. Client-agnostic — the peer's own
 * client determines what /compact or /clear looks like.
 */
export function warningBody(handle: string, level: Threshold, percent: number): string {
  const pct = percent.toFixed(1);
  switch (level) {
    case 70:
      return `🟡 You're at ${pct}% context. Consider a hygiene pass (\`/compact\` in Claude Code, equivalent in your client) soon.`;
    case 85:
      return `🟠 ${handle} at ${pct}% context. Recommend hygiene (\`/compact\`, \`/clear\`, or restart) before continuing.`;
    case 95:
      return `🔴 ${handle} at ${pct}% context. Hygiene action needed before the next tool call — messages after this may be truncated.`;
  }
}
