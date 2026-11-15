import * as dao from "../storage/dao.js";
import type { Db } from "../storage/db.js";
import { notifyPeer } from "../notify/bus.js";

export interface AnnounceToRoomInput {
  room: string;
  body: string;
  /**
   * The handle that CAUSED the announcement, which is not notified. It already
   * knows: it is the operator or agent that ran the command.
   */
  actor: string;
  /**
   * Advance `actor`'s read watermark past the announcement.
   *
   * 🛑 NO DEFAULT, for the reason `sendToRoom`'s `advanceOwnRead` has none. The
   * three boot surfaces genuinely disagreed — the REPL advanced and the other
   * two did not — and that disagreement was invisible while the code was
   * copied three times. A default would re-hide it.
   */
  advanceActorRead: boolean;
}

export interface AnnounceToRoomResult {
  id: number;
  sent_at: number;
  /** Recipients notified, which is the member count minus the actor. */
  notified: number;
}

/**
 * Post a `system` message to a room and wake every member but the actor.
 *
 * 🛑 THIS EXISTS SO `insertMessage` IS THE ONLY WRITER. Three surfaces each
 * built this announcement with their own `INSERT INTO messages` and their own
 * `lastInsertRowid` read, skipping the `changes` check, the witness re-read and
 * the file-identity check. A statement that inserts nothing still returns a
 * rowid — from another table — so the id they fanned out named a message that
 * was never written. #138.
 *
 * ⚠️ NOT `sendToRoom`. That one refuses a sender who is not a member, and
 * `SYSTEM_HANDLE` never is. It also skips the sender when notifying, where this
 * skips the ACTOR and the sender is nobody.
 */
export function announceToRoom(
  db: Db,
  input: AnnounceToRoomInput,
): AnnounceToRoomResult {
  const { room, body, actor, advanceActorRead } = input;

  const sent = dao.insertMessage(db, {
    from: dao.SYSTEM_HANDLE,
    to: room,
    body,
  });

  if (advanceActorRead) dao.advanceRoomRead(db, room, actor, sent.id);

  let notified = 0;

  for (const member of dao.roomMembers(db, room)) {
    if (member === actor) continue;

    notifyPeer(member, {
      id: sent.id,
      to: room,
      from: dao.SYSTEM_HANDLE,
      ts: sent.sent_at,
      body,
    });

    notified += 1;
  }

  return { id: sent.id, sent_at: sent.sent_at, notified };
}
