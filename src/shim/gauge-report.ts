import type { DatabaseSync } from "node:sqlite";
import * as dao from "../storage/dao.js";
import { notifyPeer } from "../notify/bus.js";
import {
  nextGaugeState,
  warningBody,
  deliveryFor,
  type Threshold,
} from "./gauge.js";

export interface ContextReport {
  used: number;
  total: number;
  percent: number;
  warned: Threshold | null;
  fired: Threshold | null;
  notified: { dm: number; rooms: string[] };
}

/**
 * Record one context reading and deliver whatever band it just crossed.
 *
 * 🛑 THE WHOLE BODY WAS COPIED IN TWO FILES. `src/oneshot/report_context.ts`
 * and `src/shim/tools/report_context.ts` each carried the write, the
 * hysteresis read-back and the DM/room fanout; `gauge.ts` had de-duplicated
 * only the band literals. #213 adds the supervisor as a third reporter, and a
 * third copy is where the three drift.
 *
 * ⚠️ VALIDATION IS THE CALLER'S, DELIBERATELY. The three disagree on purpose:
 * the hook clamps because a PreToolUse must not throw, the MCP tool refuses
 * `used > total` so the agent is told, and the supervisor clamps. Pulling any
 * of that in here would force one policy on all three.
 */
export function applyContextReport(
  db: DatabaseSync,
  handle: string,
  used: number,
  total: number,
): ContextReport {
  const me = dao.getAgent(db, handle);
  const prevWarned = (me?.context_warned_threshold ?? null) as Threshold | null;

  dao.setAgentContext(db, handle, used, total);

  const percent = total > 0 ? Math.round((used / total) * 1000) / 10 : 0;
  const transition = nextGaugeState(percent, prevWarned);

  const notified = { dm: 0, rooms: [] as string[] };
  let delivered = true;

  if (transition.fire != null) {
    const body = warningBody(handle, transition.fire, percent);
    const delivery = deliveryFor(transition.fire);

    if (delivery === "dm") {
      // Soft warning: the peer's own inbox, no room chatter yet.
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
      // 85 / 95: every room the peer is in, so co-agents and the human can
      // react. `alert` at 95 surfaces it in the alert lane.
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

          // 🛑 ABOVE THE MEMBER FANOUT. The row IS the delivery, so a throw
          // while enumerating the audience must not discard a row that has
          // already committed.
          notified.rooms.push(room.name);

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
        } catch (e) {
          // PER ROOM, so one unreachable room cannot cost the others their
          // warning. Wrapping the whole fanout loses every room when one
          // fails, which is what `backlog-check.ts` had before #224.
          console.error(
            `[chat-mcp] context warning undelivered to ${room.name} for ${handle}: ${
              e instanceof Error ? e.message : String(e)
            }`,
          );
        }
      }

      // Nothing reached anyone, so the band is not spent and a later report
      // retries it. One room failing still counts as delivered.
      delivered = rooms.length === 0 || notified.rooms.length > 0;
    }
  }

  // 🛑 AFTER THE DELIVERY, AND ONLY IF IT REACHED SOMEBODY. Spending the band
  // above would leave the agent with no warning at all, because a spent band
  // never fires again. Spending it on a PARTIAL failure is the opposite bug:
  // the rooms that did get it are re-told on every later report.
  const warned = delivered ? transition.next_warned : prevWarned;

  if (warned !== prevWarned) {
    dao.setAgentContextWarned(db, handle, warned);
  }

  return {
    used,
    total,
    percent,
    warned,
    fired: delivered ? transition.fire : null,
    notified,
  };
}
