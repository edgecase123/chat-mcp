import type { DatabaseSync } from "node:sqlite";
import * as dao from "../storage/dao.js";
import { notifyPeer } from "../notify/bus.js";
import {
  nextBacklogState,
  warningBody,
  backlogDeliveryFor,
  type Threshold,
} from "./backlog.js";

export interface BacklogCheck {
  /** Age of the oldest unread message in minutes, or `null` for none. */
  minutes: number | null;
  warned: Threshold | null;
  fired: Threshold | null;
  notified: { dm: number; rooms: string[] };
}

/**
 * Observe one agent's unread backlog and deliver whatever band it just crossed.
 *
 * 🛑 THE TICK IS THE AGENT'S OWN `send` / `room_send`, and that is the whole
 * liveness gate. An agent that is sending is demonstrably alive, so a message
 * it has left unread is being ignored rather than merely undelivered.
 * `lee-approvals` holds 1850 unread and must never fire, because it never acts.
 *
 * ⚠️ A TIMER WAS REJECTED FOR THAT REASON, and the reads were rejected because
 * a read is what CLEARS a backlog. Full options at #224's
 * `issuecomment-6935397093`.
 *
 * ⚠️ ACCEPTED LIMIT: an agent that neither reads nor sends never fires. That is
 * indistinguishable from offline, and #224 asks for no alarm there.
 *
 * @param now — injected so the bands are testable without a clock.
 */
export function applyBacklogCheck(
  db: DatabaseSync,
  handle: string,
  now: number,
): BacklogCheck {
  const me = dao.getAgent(db, handle);
  const prevWarned = (me?.unread_warned_threshold ?? null) as Threshold | null;

  const oldestAt = dao.oldestUnreadAt(db, handle);
  const minutes = oldestAt === null ? null : (now - oldestAt) / 60_000;
  const transition = nextBacklogState(minutes, prevWarned);

  if (transition.next_warned !== prevWarned) {
    dao.setAgentUnreadWarned(db, handle, transition.next_warned);
  }

  const notified = { dm: 0, rooms: [] as string[] };

  if (transition.fire != null && minutes != null) {
    const body = warningBody(handle, transition.fire, minutes);
    const delivery = backlogDeliveryFor(transition.fire);

    if (delivery === "dm") {
      // 🛑 SAFE ONLY BECAUSE `oldestUnreadAt` EXCLUDES `system`. This warning
      // lands unread in the very inbox it is complaining about, so a reader
      // that counted it would watch its own alarm age into the next band and
      // fire for ever off nothing but itself.
      const result = dao.insertMessage(db, {
        from: dao.SYSTEM_HANDLE,
        to: handle,
        body,
        kind: "chat",
      });

      notifyPeer(handle, {
        id: result.id,
        to: handle,
        from: dao.SYSTEM_HANDLE,
        ts: result.sent_at,
        body,
        kind: "chat",
      });
      notified.dm = 1;
    } else {
      // 60 / 240: a DM is evidently not reaching them, so the rooms get it.
      const kind = delivery === "alert" ? "alert" : "chat";

      for (const room of dao.myRooms(db, handle)) {
        const result = dao.insertMessage(db, {
          from: dao.SYSTEM_HANDLE,
          to: room.name,
          body,
          kind,
        });

        for (const member of dao.roomMembers(db, room.name)) {
          notifyPeer(member, {
            id: result.id,
            to: room.name,
            from: dao.SYSTEM_HANDLE,
            ts: result.sent_at,
            body,
            kind,
          });
        }
        notified.rooms.push(room.name);
      }
    }
  }

  return {
    minutes,
    warned: transition.next_warned,
    fired: transition.fire,
    notified,
  };
}
