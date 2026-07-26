import * as dao from '../storage/dao.js';
import { openDb } from '../storage/db.js';
import { notifyPeer } from '../notify/bus.js';
import { assertRoomName } from '../util/naming.js';
import { resolveHandle } from './common.js';

export interface BootOpts {
  room: string;
  handle: string;
  from?: string;
  json?: boolean;
}

export async function runBoot(opts: BootOpts): Promise<void> {
  const caller = resolveHandle(opts.from, '--from');
  assertRoomName(opts.room);

  const target = opts.handle.startsWith('@') ? opts.handle.slice(1) : opts.handle;
  if (target === caller) throw new Error('Cannot boot yourself — use room_leave instead.');

  const db = openDb();
  try {
    if (!dao.isRoomMember(db, opts.room, caller)) {
      throw new Error(`Cannot boot from ${opts.room}: ${caller} is not a member.`);
    }
    if (!dao.isRoomMember(db, opts.room, target)) {
      throw new Error(`${target} is not a member of ${opts.room}.`);
    }

    const removed = dao.bootFromRoom(db, opts.room, target);

    const now = Date.now();
    const body = `${caller} booted ${target} from ${opts.room}`;
    const sysInfo = db.prepare(
      `INSERT INTO messages (from_handle, to_handle, body, sent_at) VALUES (?, ?, ?, ?)`,
    ).run(dao.SYSTEM_HANDLE, opts.room, body, now);
    const sysId = Number(sysInfo.lastInsertRowid);

    const remaining = dao.roomMembers(db, opts.room);
    for (const member of remaining) {
      if (member === caller) continue;
      notifyPeer(member, { id: sysId, to: opts.room, from: dao.SYSTEM_HANDLE, ts: now });
    }

    if (opts.json) {
      process.stdout.write(`${JSON.stringify({ room: opts.room, handle: target, removed })}\n`);
    } else {
      process.stdout.write(`booted ${target} from ${opts.room}\n`);
    }
  } finally {
    db.close();
  }
}
