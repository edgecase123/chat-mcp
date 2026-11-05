import * as dao from '../storage/dao.js';
import { openDb } from '../storage/db.js';
import { assertRoomName } from '../util/naming.js';
import { resolveHandle } from './common.js';

export interface DeleteRoomOpts {
  room: string;
  from?: string;
  json?: boolean;
}

export async function runDeleteRoom(opts: DeleteRoomOpts): Promise<void> {
  const caller = resolveHandle(opts.from, '--from');
  assertRoomName(opts.room);

  const db = openDb();
  try {
    const result = dao.deleteRoom(db, opts.room, caller);

    if (!result.ok && result.reason === 'not-a-member') {
      throw new Error(
        `Cannot delete ${opts.room}: ${caller} is not a member. Join first, or ask a current member to delete.`,
      );
    }
    if (!result.ok && result.reason === 'owner-only') {
      throw new Error(
        `Cannot delete ${opts.room}: only ${result.owner} created it and is still a member.`,
      );
    }
    const deleted = result.ok;
    if (opts.json) {
      process.stdout.write(`${JSON.stringify({ room: opts.room, deleted })}\n`);
    } else {
      process.stdout.write(deleted ? `deleted ${opts.room}\n` : `${opts.room} did not exist\n`);
    }
  } finally {
    db.close();
  }
}
