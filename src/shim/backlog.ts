/**
 * Pure state-machine for the unread-backlog warnings.
 *
 * The axis is the AGE OF THE OLDEST UNREAD message, in minutes — not the
 * number of unread messages.
 *
 * 🛑 DEPTH WAS MEASURED AND RULED OUT. Over 26 days of `chat.db` no live agent
 * ever held more than 6 unread DMs, while 26 messages sat unread for over five
 * minutes with the recipient demonstrably still sending. No depth band both
 * fires on that and stays quiet on routine traffic. Age splits them: p50 is
 * 0.2 minutes, p95 is 407.
 *
 * 🛑 `null` IS NOT A ZERO-MINUTE BACKLOG. It is the absence of one, and it
 * clears the stored band. An agent that caught up must be able to fire again.
 *
 * ⚠️ NO HYSTERESIS MARGIN, UNLIKE `gauge.ts`. Context percent oscillates
 * around a line unprompted, so the gauge needs one. Backlog age only RISES
 * between reads, so the only thing that lowers it is a read — and a read
 * followed by a fresh climb past the same line is a new incident, not chatter.
 *
 * The state is stored per-agent as `unread_warned_threshold`, nullable
 * INTEGER, one of the band values below.
 */

import type { Delivery } from "./gauge.js";

export const BANDS = [
  { warn: 5 },
  { warn: 15 },
  { warn: 60 },
  { warn: 240 },
] as const;

export type Threshold = 5 | 15 | 60 | 240;

/**
 * ⚠️ `Delivery` IS THE GAUGE'S TYPE, IMPORTED NOT RESTATED. The band VALUES
 * differ, so the routing cannot be shared, but a second copy of the three
 * audience names could drift from the gauge's.
 */

export interface BacklogTransition {
  /** New value to persist to `unread_warned_threshold`. */
  next_warned: Threshold | null;
  /** The band newly entered on the way up, or `null` for no change and for
   * every step down. At most one fire per call. */
  fire: Threshold | null;
}

/**
 * The highest band this age has reached, or `null` below the first one.
 *
 * 🛑 THE WHOLE TRANSITION IS DERIVED FROM THIS, which is why there is no
 * step-down chain. `gauge.ts` carries four hardcoded `if` steps and its own
 * docblock warns that stopping the cascade early strands a band; a single
 * "highest band reached" has no cascade to get wrong.
 */
function bandReached(minutes: number): Threshold | null {
  let reached: Threshold | null = null;
  for (const band of BANDS)
    if (minutes >= band.warn) reached = band.warn as Threshold;

  return reached;
}

/**
 * Compute the state transition for one backlog observation.
 *
 * @param oldestUnreadMinutes — age of the oldest unread message, or `null`
 *   when nothing is unread.
 * @param prevWarned — value currently in `unread_warned_threshold`.
 */
export function nextBacklogState(
  oldestUnreadMinutes: number | null,
  prevWarned: Threshold | null,
): BacklogTransition {
  if (oldestUnreadMinutes === null) return { next_warned: null, fire: null };

  const reached = bandReached(oldestUnreadMinutes);
  const climbed =
    reached !== null && (prevWarned === null || reached > prevWarned);

  return { next_warned: reached, fire: climbed ? reached : null };
}

/**
 * Where a band's warning goes.
 *
 * 🛑 THE LOUD BANDS LEAVE THE AGENT'S OWN DM CHANNEL ON PURPOSE. A DM to a
 * peer that is not reading its DMs is the defect, not the alarm.
 *
 * ⚠️ NOT NAMED `deliveryFor`. `gauge-bands.test.ts` asserts exactly one file
 * outside `gauge.ts` mentions that name, and it caught this module defining a
 * second function under it. Two routers with one name is the real problem the
 * guard found; the prefix is the fix.
 */
export function backlogDeliveryFor(level: Threshold): Delivery {
  switch (level) {
    case 5:
    case 15:
      return "dm";
    case 60:
      return "room";
    case 240:
      return "alert";
  }
}

/**
 * Body copy for a warning at each level.
 *
 * ⚠️ NO BAND NAMES ITS OWN LINE. A band's copy is read anywhere from its own
 * threshold up to the next one, so "over 5 minutes" would be wrong at 300.
 * `gauge.ts` shipped that defect once already.
 */
export function warningBody(
  handle: string,
  level: Threshold,
  oldestUnreadMinutes: number,
): string {
  const age = Math.round(oldestUnreadMinutes);
  switch (level) {
    case 5:
      return `🔵 You have unread bus messages, the oldest waiting ${age} min. Call \`inbox\` and \`room_inbox\` before your next turn — somebody is waiting on a reply you have not read.`;
    case 15:
      return `🟡 Your oldest unread bus message has waited ${age} min. Read it now: a peer that asked you something has had no answer and no acknowledgement.`;
    case 60:
      return `🟠 ${handle} has an unread bus message ${age} min old. Posting here because DMs are evidently not reaching them.`;
    case 240:
      return `🔴 ${handle} has an unread bus message ${age} min old and has not read it. Whoever is waiting on ${handle} should assume no answer is coming and route around them.`;
  }
}
