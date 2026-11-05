/**
 * Resolving a link to a single message (#104).
 *
 * A message id is how agents refer to messages to each other. "See 12582" was
 * unreachable for the human reading the same room, who could only scroll.
 *
 * 🛑 THE ID IS GLOBALLY UNIQUE, SO THE LINK NEED NOT CARRY THE CONVERSATION.
 * `#m12582` is enough, and the server resolves which conversation it belongs
 * to. The alternative — putting target and id both in the fragment — makes a
 * longer link that can also disagree with itself.
 */

/** A parsed `around_id`, or why it was refused. */
export type AroundId = { ok: true; id: number } | { ok: false; reason: string };

/**
 * ⚠️ REFUSES ANYTHING `parseInt` WOULD ACCEPT LOOSELY. `parseInt('12x')` is 12
 * and `parseInt('')` is NaN, so a hand-edited fragment would otherwise either
 * silently resolve the wrong message or reach the DAO as NaN.
 */
export function parseAroundId(raw: string | null | undefined): AroundId {
  if (raw === null || raw === undefined || raw === '') {
    return { ok: false, reason: 'around_id required' };
  }
  if (!/^[0-9]+$/.test(raw)) {
    return { ok: false, reason: 'around_id must be a positive integer' };
  }

  const id = Number(raw);

  if (!Number.isSafeInteger(id) || id <= 0) {
    return { ok: false, reason: 'around_id must be a positive integer' };
  }

  return { ok: true, id };
}

/**
 * Which conversation a message belongs to, FROM THIS READER'S SEAT.
 *
 * 🛑 A DM'S TARGET IS THE OTHER PARTY, AND WHICH ONE THAT IS DEPENDS ON WHO IS
 * ASKING. `to_handle` alone is wrong half the time: for a message I sent, the
 * conversation is named after the recipient; for one I received, after the
 * sender. A room is its own name either way.
 *
 * @param msg the stored row's two handles
 * @param me the reader's handle
 */
export function targetForMessage(msg: { from_handle: string; to_handle: string }, me: string): string {
  if (msg.to_handle.startsWith('#')) return msg.to_handle;

  return msg.from_handle === me ? msg.to_handle : msg.from_handle;
}

/**
 * Whether this reader is entitled to see a DM at all.
 *
 * 🛑 `around_id` MUST NOT BE A SOFTER DOOR THAN `target=` ON THE SAME ROUTE.
 * `/api/messages?target=` checks room membership before returning anything, so
 * an id-based lookup that skipped the equivalent check would be a bypass of it.
 * Rooms are checked by the caller against `room_members`; a DM is checked here.
 */
export function readerIsPartyToDm(msg: { from_handle: string; to_handle: string }, me: string): boolean {
  if (msg.to_handle.startsWith('#')) return false;

  return msg.from_handle === me || msg.to_handle === me;
}

/**
 * How many messages to fetch either side of the anchor.
 *
 * The anchor should land in the MIDDLE of the window, because the reader
 * usually wants the context that came before the message they followed.
 * An odd limit gives the extra row to the older side for that reason.
 */
export function aroundWindow(limit: number): { before: number; after: number } {
  const span = Math.max(1, Math.floor(limit)) - 1;
  const after = Math.floor(span / 2);

  return { before: span - after, after };
}
