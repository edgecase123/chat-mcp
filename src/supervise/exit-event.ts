import * as dao from "../storage/dao.js";
import type { Db } from "../storage/db.js";
import { announceToRoom } from "../messaging/room-announce.js";

export interface ChildExitEvent {
  /** The handle this supervisor serves, which is how peers address the agent. */
  supervisorHandle: string;
  /** The handle the CHILD held on the bus, which is the row that went offline. */
  childHandle: string;
  code: number | null;
  signal: string | null;
}

/**
 * The rooms that must hear about this agent's death, each one once.
 *
 * 🛑 BOTH HANDLES, AND THAT IS A MEASUREMENT RATHER THAN A PREFERENCE. The
 * handle that goes offline is the child's `-agent` handle, so announcing to
 * only its rooms is the obvious reading — and on the live bus it reaches
 * NOBODY. `room_members` held 11 rows on 2026-11-16 and none was an `-agent`
 * handle: peers know the agent by the supervisor's handle. Announcing to only
 * one of the two is silent under one of the two registration shapes.
 */
function roomsToTell(db: Db, event: ChildExitEvent): string[] {
  const names = new Set<string>();

  for (const handle of [event.supervisorHandle, event.childHandle])
    for (const room of dao.myRooms(db, handle)) names.add(room.name);

  return [...names].sort();
}

/** `code=243 signal=null`, the one detail an operator starts a diagnosis from. */
function reason(event: ChildExitEvent): string {
  return `code=${String(event.code)} signal=${String(event.signal)}`;
}

/**
 * Say on the bus that this agent's child died, and that its supervisor is going
 * with it.
 *
 * 🛑 AN ABSENCE IS NOT AN EVENT. `clearAgentPid` already makes the handle read
 * offline, which an operator sees as a GAP — indistinguishable from an agent
 * that was never started. lee ruled on 2026-11-16 that the exit is surfaced as
 * a bus event, emitted BEFORE the supervisor exits.
 *
 * ⚠️ `kind: "alert"`. The two INTENTIONAL exits never reach this — a stop and
 * a replace are excluded by the caller — so everything here is an unexpected
 * death that silently un-did somebody's hand-off.
 *
 * ⚠️ NOT REACHED: a peer who only ever DMs this agent and shares no room with
 * it. Rooms are the bus's broadcast; a fan-out to every past correspondent is
 * a different feature.
 *
 * @returns the rooms told, for the caller's log.
 */
export function announceChildExit(db: Db, event: ChildExitEvent): string[] {
  const rooms = roomsToTell(db, event);
  const body =
    `🔴 ${event.childHandle} exited (${reason(event)}). ` +
    `Its supervisor is shutting down, so ${event.supervisorHandle} is offline ` +
    `and anything handed to it was not done.`;

  for (const room of rooms)
    announceToRoom(db, {
      room,
      body,
      // 🛑 NOBODY CAUSED THIS, so nobody is skipped. `announceToRoom` omits the
      // ACTOR from the fan-out, and `SYSTEM_HANDLE` is never a member.
      actor: dao.SYSTEM_HANDLE,
      advanceActorRead: false,
      kind: "alert",
    });

  return rooms;
}
