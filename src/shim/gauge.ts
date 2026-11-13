/**
 * Pure state-machine for the context-gauge threshold warnings.
 *
 * The gauge has four warning bands:
 *   plan  (quiet)  — used ≥ 50% of total. DM to the peer only.
 *   soft  (yellow) — used ≥ 70%. DM to the peer only.
 *   warn  (orange) — used ≥ 85%. Room-post visible to co-agents + human.
 *   crit  (red)    — used ≥ 95%. Room-post with kind='alert'.
 *
 * 🛑 50 IS A PLANNING LINE, NOT AN EARLIER CRISIS LINE. By 70% it is often
 * too late to compact mid-task without losing continuity, so 50 asks the peer
 * to pick a break point while they still have one. Its sentence differs on
 * purpose — an earlier copy of "consider /compact" would be noise.
 *
 * ⚠️ A BAND'S COPY IS READ ANYWHERE FROM ITS OWN LINE TO THE NEXT ONE. A
 * fresh peer reporting 68% fires 50, so the 50 copy said "68.0% — half of it"
 * until claude1 caught it on PR 113. No band may name its own fraction.
 *
 * Hysteresis of 5% under each band prevents chatter when the peer sits
 * right at the boundary.
 *
 * 🛑 A STEP DOWN CASCADES AS FAR AS THE PERCENT WARRANTS, in one report. An
 * earlier version of this comment said "one band at a time" and the code
 * never did that; the step-downs below are sequential, so 95 to 5% reaches
 * null directly. The cascade is load-bearing: stopping at 85 would mean a
 * climb back to 71% never fires 70 again.
 *
 * The state is stored per-peer as `context_warned_threshold` (nullable
 * INTEGER, one of 50 | 70 | 85 | 95). A fresh peer is null; on the way up we
 * warn once as we enter each band; on the way down we downshift silently.
 */

export const BANDS = [
  { warn: 50, reset: 45 },
  { warn: 70, reset: 65 },
  { warn: 85, reset: 80 },
  { warn: 95, reset: 90 },
] as const;

export type Threshold = 50 | 70 | 85 | 95;

/**
 * The band that asks for a plan rather than a hygiene pass.
 *
 * 🛑 EXPORTED FOR THE WEB GAUGE TO EXCLUDE, and that exclusion is the ONLY
 * thing that distinguishes the colour ramp from `BANDS`. An earlier comment in
 * `logic.js` said the ramp mirrored the room-post bands; it does not — 70 is
 * `dm` and is coloured. claude1 caught it on PR 113.
 */
export const PLANNING_BAND = 50 as const;

/** How a band reaches its audience. */
export type Delivery = 'dm' | 'room' | 'alert';

export interface GaugeTransition {
  /** New value to persist to context_warned_threshold. */
  next_warned: Threshold | null;
  /**
   * The band we just newly entered on the way up. `null` if this report
   * didn't cross any threshold (either no change, or a step-down). At
   * most one fire per report — a large jump straight to critical only
   * fires 95, not 50+70+85+95.
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

  // Step down (hysteresis, no fire). Sequential on purpose — see the cascade
  // note in this module's docblock.
  if (fire == null) {
    if (next === 95 && percent < 90) next = 85;
    if (next === 85 && percent < 80) next = 70;
    if (next === 70 && percent < 65) next = 50;
    if (next === 50 && percent < 45) next = null;
  }

  return { next_warned: next, fire };
}

/**
 * Where a band's warning goes.
 *
 * 🛑 ONE CALLER, AND `gauge-bands.test.ts` FAILS IF A SECOND APPEARS.
 * `src/oneshot/report_context.ts` and `src/shim/tools/report_context.ts` each
 * tested `fire === 70` to pick DM over room, so a second DM level meant
 * editing a literal in two files. Both now go through `applyContextReport`,
 * which is the only thing that calls this.
 *
 * lee ruled on 2026-11-04 that the 50 band is DM-only, so it earns no room
 * post and no colour in the web gauge.
 */
export function deliveryFor(level: Threshold): Delivery {
  switch (level) {
    case 50:
    case 70:
      return 'dm';
    case 85:
      return 'room';
    case 95:
      return 'alert';
  }
}

/**
 * Body copy for a warning at each level. Client-agnostic — the peer's own
 * client determines what /compact or /clear looks like.
 */
export function warningBody(handle: string, level: Threshold, percent: number): string {
  const pct = percent.toFixed(1);
  switch (level) {
    case 50:
      return `🔵 You're at ${pct}% context, past halfway. Pick your break point now, while you still have one: name what you are mid-way through, and where it would be safe to stop.`;
    case 70:
      return `🟡 You're at ${pct}% context. Consider a hygiene pass (\`/compact\` in Claude Code, equivalent in your client) soon.`;
    case 85:
      return `🟠 ${handle} at ${pct}% context. Recommend hygiene (\`/compact\`, \`/clear\`, or restart) before continuing.`;
    case 95:
      return `🔴 ${handle} at ${pct}% context. Hygiene action needed before the next tool call — messages after this may be truncated.`;
  }
}
