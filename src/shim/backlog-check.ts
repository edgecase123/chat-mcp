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

  const notified = { dm: 0, rooms: [] as string[] };
  let delivered = true;

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

      const rooms = dao.myRooms(db, handle);

      for (const room of rooms) {
        try {
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
        } catch (e) {
          // PER ROOM, so one unwritable room cannot cost the others their
          // warning — and cannot leave the band unspent, which re-delivers.
          console.error(
            `[chat-mcp] backlog warning undelivered to ${room.name} for ${handle}: ${
              e instanceof Error ? e.message : String(e)
            }`,
          );
        }
      }

      // Nothing reached anyone, so the band is not spent and the next send
      // retries it. One room failing still counts as delivered.
      delivered = rooms.length === 0 || notified.rooms.length > 0;
    }
  }

  // 🛑 AFTER THE DELIVERY, AND ONLY IF IT REACHED SOMEBODY. Spending the band
  // above would leave the agent with no warning at all, because a spent band
  // never fires again. Spending it on a PARTIAL failure is the opposite bug:
  // the rooms that did get it are re-told on every later send.
  const warned = delivered ? transition.next_warned : prevWarned;

  if (warned !== prevWarned) {
    dao.setAgentUnreadWarned(db, handle, warned);
  }

  return {
    minutes,
    warned,
    fired: delivered ? transition.fire : null,
    notified,
  };
}

/**
 * `applyBacklogCheck` for a caller whose own work has ALREADY persisted.
 *
 * 🛑 A THROW HERE TOLD THE AGENT ITS SEND FAILED WHEN IT HAD SUCCEEDED, and
 * the only recovery an agent has is to send again — which duplicates. The
 * message and the peer's wake both go out above the tick, so by the time this
 * runs there is nothing left to roll back.
 *
 * ⚠️ `gauge-report.ts` DELIBERATELY DOES NOT DO THIS. There the check IS the
 * tool's whole job, so a throw is an honest failure. Here it is advisory
 * bookkeeping after the fact, and a warning that cannot be delivered must not
 * cost the agent its message.
 *
 * ⚠️ NOT SILENT. A swallowed failure that leaves no trace is indistinguishable
 * from an empty backlog, so the reason goes to stderr — stdout is the MCP
 * protocol stream.
 *
 * @returns the reading, or `null` when the check itself failed.
 */
export function tickBacklogSafely(
  db: DatabaseSync,
  handle: string,
  now: number,
): BacklogCheck | null {
  try {
    return applyBacklogCheck(db, handle, now);
  } catch (e) {
    console.error(
      `[chat-mcp] unread-backlog check failed for ${handle}: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );

    return null;
  }
}
