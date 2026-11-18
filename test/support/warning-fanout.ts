import type { DatabaseSync } from "node:sqlite";
import * as dao from "../../src/storage/dao.js";

/**
 * Helpers for the two warning fanouts — `backlog-check.ts` and
 * `gauge-report.ts` — which deliver the same way and have the same failure
 * modes.
 *
 * 🛑 TEST INFRASTRUCTURE. Never import it from `src/`.
 */

/**
 * Make the member lookup fail while the room lookup and the room write keep
 * working.
 *
 * A view over `room_members` without `joined_at` fails at prepare for EVERY
 * query naming that column, so `myRooms`, the membership check and
 * `roomUnread` all still work and the warning row still commits — only the
 * wake's audience cannot be enumerated.
 *
 * 🛑 CALL THIS AFTER ALL ROOM SETUP. `joinRoom` reads `joined_at` too, so a
 * join below this line throws instead of joining, and the test then measures
 * an empty fixture.
 */
export function breakMemberLookup(db: DatabaseSync): void {
  db.exec(`ALTER TABLE room_members RENAME TO room_members_real`);
  db.exec(
    `CREATE VIEW room_members AS SELECT room_name, handle FROM room_members_real`,
  );
}

/** The system-written warnings a room is holding. */
export function warningsIn(db: DatabaseSync, room: string): unknown[] {
  return dao
    .roomUnread(db, room, "peer")
    .filter((m) => m.from_handle === dao.SYSTEM_HANDLE);
}

/**
 * Capture `console.error` so a deliberate failure does not print, and so the
 * test can assert the injection actually fired.
 */
export function quietStderr(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const real = console.error;
  console.error = (...args: unknown[]) => void lines.push(args.join(" "));

  return { lines, restore: () => void (console.error = real) };
}

/**
 * Make one room's system-written row fail to insert, leaving every other room
 * and every lookup working.
 *
 * Unlike {@link breakMemberLookup} this is per room, so it is the only way to
 * get a PARTIAL delivery — some rooms reached, some not.
 */
export function breakRoom(db: DatabaseSync, room: string): void {
  db.exec(
    `CREATE TRIGGER break_${room.slice(1)} BEFORE INSERT ON messages
       WHEN NEW.to_handle = '${room}' AND NEW.from_handle = '${dao.SYSTEM_HANDLE}'
       BEGIN SELECT RAISE(ABORT, 'injected: room unwritable'); END`,
  );
}
