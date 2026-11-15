import * as dao from "../storage/dao.js";
import { openDb } from "../storage/db.js";
import { announceToRoom } from "../messaging/room-announce.js";
import { assertRoomName } from "../util/naming.js";
import { resolveHandle } from "./common.js";

export interface BootOpts {
  room: string;
  handle: string;
  from?: string;
  json?: boolean;
}

export async function runBoot(opts: BootOpts): Promise<void> {
  const caller = resolveHandle(opts.from, "--from");
  assertRoomName(opts.room);

  const target = opts.handle.startsWith("@")
    ? opts.handle.slice(1)
    : opts.handle;
  if (target === caller)
    throw new Error("Cannot boot yourself — use room_leave instead.");

  const db = openDb();
  try {
    if (!dao.isRoomMember(db, opts.room, caller)) {
      throw new Error(
        `Cannot boot from ${opts.room}: ${caller} is not a member.`,
      );
    }
    if (!dao.isRoomMember(db, opts.room, target)) {
      throw new Error(`${target} is not a member of ${opts.room}.`);
    }

    const removed = dao.bootFromRoom(db, opts.room, target);

    const body = `${caller} booted ${target} from ${opts.room}`;

    // 🛑 ONE WRITER. The raw insert this replaced skipped every guard in
    // `insertMessage` and fanned out a `lastInsertRowid` that a swallowed
    // insert takes from another table. #138.
    //
    // ⚠️ THE THROW IS LET OUT ON PURPOSE. A oneshot verb exits non-zero, which
    // is already loud; `sendOrReason` is for the two surfaces that must stay up.
    announceToRoom(db, {
      room: opts.room,
      body,
      actor: caller,
      // This verb prints and exits, so there is no inbox of its own to keep
      // clear. The REPL is the one surface that advances.
      advanceActorRead: false,
    });

    if (opts.json) {
      process.stdout.write(
        `${JSON.stringify({ room: opts.room, handle: target, removed })}\n`,
      );
    } else {
      process.stdout.write(`booted ${target} from ${opts.room}\n`);
    }
  } finally {
    db.close();
  }
}
