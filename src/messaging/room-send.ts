import * as dao from '../storage/dao.js';
import type { Db } from '../storage/db.js';
import type { MessageKind } from '../storage/dao.js';
import { notifyPeer } from '../notify/bus.js';
import { assertRoomName } from '../util/naming.js';

export const MAX_BODY_BYTES = 64 * 1024;

/**
 * 🛑 THE BASE CLASS IS THE POINT, not the subclasses. A caller must be able to
 * map CALLER MISTAKES to a 4xx while letting a failed write or a full disk stay
 * a 5xx. Catching `Error` answers 400 for both.
 */
export class RoomSendInputError extends Error {}

export class NotARoomMemberError extends RoomSendInputError {
  constructor(
    readonly room: string,
    readonly handle: string,
  ) {
    super(`${handle} is not a member of ${room}`);
    this.name = 'NotARoomMemberError';
  }
}

export class BodyTooLargeError extends RoomSendInputError {
  constructor(readonly bytes: number) {
    super(`Message body exceeds ${MAX_BODY_BYTES}-byte cap`);
    this.name = 'BodyTooLargeError';
  }
}

export class InvalidRoomNameError extends RoomSendInputError {
  constructor(readonly room: string, cause: Error) {
    super(cause.message);
    this.name = 'InvalidRoomNameError';
  }
}

export interface SendToRoomInput {
  from: string;
  room: string;
  body: string;
  kind?: MessageKind;
  /**
   * 🛑 NO DEFAULT, because the three callers genuinely disagree and the wrong
   * one is silent. `room_send` must pass false; the web UI and the TUI pass
   * true. `roomUnread` already excludes a reader's own posts by author, so a
   * sender that also advances skips whatever a sibling posted in between.
   */
  advanceOwnRead: boolean;
}

export interface SendToRoomResult {
  id: number;
  sent_at: number;
  /** Recipients notified, which is the member count minus the sender. */
  notified: number;
}

/**
 * Post to a room and wake every other member.
 *
 * Does NOT touch `last_seen` — only the MCP tool does that, and it owns the
 * decision about what counts as agent liveness.
 */
export function sendToRoom(db: Db, input: SendToRoomInput): SendToRoomResult {
  const { from, room, body, kind, advanceOwnRead } = input;

  try {
    assertRoomName(room);
  } catch (e) {
    throw new InvalidRoomNameError(room, e as Error);
  }

  const bytes = Buffer.byteLength(body, 'utf8');
  if (bytes > MAX_BODY_BYTES) throw new BodyTooLargeError(bytes);
  if (!dao.isRoomMember(db, room, from)) throw new NotARoomMemberError(room, from);

  const sent = dao.insertMessage(db, { from, to: room, body, kind });
  if (advanceOwnRead) dao.advanceRoomRead(db, room, from, sent.id);

  let notified = 0;
  for (const member of dao.roomMembers(db, room)) {
    if (member === from) continue;
    const unread = dao.totalUnreadFor(db, member);
    notifyPeer(member, { id: sent.id, to: room, from, ts: sent.sent_at, body, kind, unread });
    notified += 1;
  }

  return { id: sent.id, sent_at: sent.sent_at, notified };
}
