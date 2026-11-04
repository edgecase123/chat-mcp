/**
 * Who holds a shared resource, for how long, and what happens when two agents
 * want the same one.
 *
 * 🛑 A CLAIM USED TO BE PROSE IN A CHAT MESSAGE. Nothing could query it,
 * nothing expired it, and it scrolled out of view while still held — so a
 * second agent could start a 22-minute gate against a tree the first was
 * mid-edit on, and nobody learned until it failed (#101).
 *
 * 🛑 EVERY DECISION IS HERE AND PURE. The DAO stores what this returns and
 * decides nothing, because a lock that is wrong is silent rather than loud.
 *
 * 🛑 EXPIRY IS A FAILSAFE, NOT A SCHEDULE. lee, ruling #101's open questions:
 * *"Claims should have default expiry that is generous, but the onus should
 * also be to clear them when done. Default is a failsafe."* So the TTL is set
 * far beyond any legitimate hold, and a takeover after expiry is REPORTED
 * rather than silent.
 */

/**
 * Four hours.
 *
 * 🛑 CHOSEN TO BE WRONG IN THE SAFE DIRECTION. A full gate is about 23
 * minutes, and one ran 8.3 hours when the host slept. A TTL near the real
 * duration would release a claim that is still held, which is the collision
 * this table exists to prevent, arriving by a different door.
 */
export const DEFAULT_TTL_MINUTES = 240;

/**
 * The TTL in minutes, from the environment.
 *
 * ⚠️ JUNK FALLS BACK RATHER THAN BECOMING ZERO. A zero TTL expires every claim
 * the moment it is made, and the symptom is "nothing is ever claimed" — which
 * reads as the feature not working rather than as a bad setting.
 */
export function ttlMinutes(env: Record<string, string | undefined> = process.env): number {
  const raw = env.CHAT_MCP_CLAIM_TTL_MINUTES;
  if (raw === undefined || raw === '') return DEFAULT_TTL_MINUTES;

  const n = Number(raw);

  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TTL_MINUTES;
}

export interface ClaimRow {
  readonly id: number;
  readonly resource: string;
  readonly holder: string;
  readonly note: string | null;
  readonly claimed_at: number;
  readonly expires_at: number;
  readonly released_at: number | null;
}

/** Held right now: not released, and not past its expiry. */
export function isLive(row: ClaimRow, now: number): boolean {
  return row.released_at === null && row.expires_at > now;
}

/** Milliseconds left on a claim, floored at zero so a caller never prints a negative. */
export function remainingMs(row: ClaimRow, now: number): number {
  return Math.max(0, row.expires_at - now);
}

export interface ClaimDecision {
  /**
   * `granted` — the resource was free, expired, or released.
   * `renewed` — the same holder extended their own live claim.
   * `conflict` — someone else holds it, and nothing was written.
   */
  readonly outcome: 'granted' | 'renewed' | 'conflict';
  /** When the new or extended claim runs out. Absent on a conflict. */
  readonly expires_at?: number;
  /** On a conflict, who has it. A refusal nobody can act on is half a refusal. */
  readonly heldBy?: string;
  /** On a conflict, how long until the failsafe would free it. */
  readonly remainingMs?: number;
  /** Set when the grant stepped over an EXPIRED claim, never a released one. */
  readonly tookOverFrom?: string;
}

export function decideClaim(input: {
  /** The newest claim row for this resource, live or not. */
  readonly existing: ClaimRow | null;
  readonly resource: string;
  readonly holder: string;
  readonly now: number;
  readonly ttlMinutes: number;
}): ClaimDecision {
  const expires_at = input.now + input.ttlMinutes * 60_000;
  const { existing, now } = input;

  if (existing === null) return { outcome: 'granted', expires_at };

  if (isLive(existing, now)) {
    // 🛑 THE SAME HOLDER RENEWS. A retry must not read as a collision with
    // itself, or a transient failure turns a held lock into a refusal.
    if (existing.holder === input.holder) return { outcome: 'renewed', expires_at };

    return {
      outcome: 'conflict',
      heldBy: existing.holder,
      remainingMs: remainingMs(existing, now),
    };
  }

  // 🛑 AN EXPIRED CLAIM IS TAKEN OVER AUDIBLY. The failsafe firing means
  // somebody never released, and granting silently hides that.
  if (existing.released_at === null) {
    return { outcome: 'granted', expires_at, tookOverFrom: existing.holder };
  }

  return { outcome: 'granted', expires_at };
}

export interface ReleaseDecision {
  /**
   * `released` — the row should be marked released.
   * `not-yours` — someone else holds it and `force` was not given.
   * `not-held` — nothing live to release. A typo is not a success.
   */
  readonly outcome: 'released' | 'not-yours' | 'not-held';
  readonly heldBy?: string;
  /** Set when `force` released someone else's live claim. */
  readonly forcedFrom?: string;
}

export function decideRelease(input: {
  readonly existing: ClaimRow | null;
  readonly by: string;
  readonly force: boolean;
  readonly now: number;
}): ReleaseDecision {
  const { existing, now } = input;

  // 🛑 LIVENESS IS CHECKED BEFORE OWNERSHIP, AND BEFORE `force`. Otherwise a
  // forced release reports success against a claim nobody held.
  if (existing === null || !isLive(existing, now)) return { outcome: 'not-held' };

  if (existing.holder === input.by) return { outcome: 'released' };

  // The override exists because an agent that died holding a claim leaves a
  // lock nobody else can clear. Same split `prune-test-agents.mjs` draws: the
  // guard about a live peer has an override, the structural ones do not.
  if (input.force) return { outcome: 'released', forcedFrom: existing.holder };

  return { outcome: 'not-yours', heldBy: existing.holder };
}
