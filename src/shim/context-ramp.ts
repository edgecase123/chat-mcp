/**
 * The quiet approach to a supervised agent's restart gate.
 *
 * lee ruled the shape on 2026-11-17 — *"if the threashold is 50% then the
 * gradients should be 50% of that, 75% of that, 85% of that..."* — so each
 * band is a fraction OF the handle's own gate rather than an absolute percent:
 *
 *   band 1   50% of gate
 *   band 2   75% of gate
 *   band 3   85% of gate
 *   GATE    100% of gate   notice, countdown, restart — NOT this module
 *
 * 🛑 RELATIVE IS WHAT MAKES THE PER-HANDLE OVERRIDE WORK. A handle gated at 80
 * gets 40/60/68 off the same three fractions, so raising one handle's gate
 * moves its whole ramp and needs no second piece of config.
 *
 * 🛑 THE GATE ITSELF IS NOT A BAND HERE. The notice, the countdown and the
 * restart are one event with one owner, and a ramp that also fired at the gate
 * would give that event two.
 *
 * ⚠️ PURE AND UNWIRED. Nothing calls this yet. `resolveContextGate` supplies
 * the gate and the supervisor supplies the floor; neither belongs in here.
 */

/** lee's three gradients, as fractions of the gate. */
export const RAMP_FRACTIONS = [0.5, 0.75, 0.85] as const;

export interface RampBand {
  /** 1-based and ascending. 1 is the quietest, 3 the last one before the gate. */
  level: number;
  /** The fraction of the gate this band sits at. */
  fraction: number;
  /** The fill percent it fires at, to one decimal. */
  at: number;
}

export interface RampTransition {
  /** The band to persist. Latched — it never steps back down. */
  next_level: number | null;
  /** The band newly crossed by this reading, or null. At most one per reading. */
  fire: RampBand | null;
}

/**
 * One decimal, because that is the precision a reading arrives at.
 *
 * `applyContextReport` computes `Math.round((used / total) * 1000) / 10`, so a
 * band carrying more precision than that could never be reached exactly.
 */
function toReadingPrecision(value: number): number {
  return Math.round(value * 10) / 10;
}

function assertLegal(value: number, what: string, min: number): void {
  if (!Number.isFinite(value) || value < min) {
    throw new Error(
      `context ramp: ${what} must be a finite number of at least ${min}, got ${value}`,
    );
  }
}

/**
 * The bands below `gate`, skipping any the agent is already past at spawn.
 *
 * 🛑 A FRESH CHILD IS NOT AT 0%. One measured container child sat at 14.4% of
 * its window before doing any work, so a low gate puts band 1 under the
 * starting fill and it fires on turn 0, every time.
 *
 * ⚠️ `floor` IS A PARAMETER AND THE NUMBER IS DELIBERATELY ABSENT FROM THIS
 * FILE. A child's starting fill is its system prompt plus its tool
 * definitions, so a child with different MCP servers has a different floor.
 * Read it at spawn and pass it. Raised by claude2 against a hardcoded clamp.
 *
 * A band exactly AT the floor is skipped too — it has already been passed.
 *
 * ⚠️ AN EMPTY RAMP IS A LEGAL ANSWER. A child whose starting fill already
 * exceeds its gate has no quiet approach left. The gate still fires.
 *
 * 🛑 AN ILLEGAL GATE THROWS. `resolveContextGate` is documented never to
 * return one, so a caller handing this a 0 or a 101 has a bug upstream, and a
 * silently empty ramp would hide it.
 */
export function rampFor(gate: number, floor = 0): RampBand[] {
  assertLegal(floor, "a starting fill", 0);
  assertLegal(gate, "a gate", 1);
  if (!Number.isInteger(gate) || gate > 100) {
    throw new Error(
      `context ramp: a gate must be a whole percentage from 1 to 100, got ${gate}`,
    );
  }

  return RAMP_FRACTIONS.map((fraction, i) => ({
    level: i + 1,
    fraction,
    at: toReadingPrecision(gate * fraction),
  })).filter((band) => band.at > floor);
}

/**
 * The transition one reading causes against a ramp.
 *
 * 🛑 EACH BAND FIRES AT MOST ONCE PER CONTEXT LIFETIME. A notification on
 * every reading above band 1 is noise, and quiet is the whole reason the ramp
 * sits below the gate instead of at it. The caller clears the stored level
 * when it restarts the agent, and that is what bounds the lifetime.
 *
 * 🛑 NO HYSTERESIS, WHICH IS THE OPPOSITE OF `gauge.ts` ON PURPOSE. The gauge
 * steps back down so a peer who compacted is warned again later. Here a drop
 * in fill means the agent did the hygiene the ramp was asking for, so
 * re-arming the band would warn them for succeeding.
 *
 * At most one band fires per reading: a jump straight past band 3 fires 3
 * alone, matching `nextGaugeState`.
 */
export function nextRampState(
  percent: number,
  ramp: RampBand[],
  prevLevel: number | null,
): RampTransition {
  let next = prevLevel;
  let fire: RampBand | null = null;

  for (const band of ramp) {
    if (percent >= band.at && (next == null || next < band.level)) {
      fire = band;
      next = band.level;
    }
  }

  return { next_level: next, fire };
}
