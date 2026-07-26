import * as dao from '../storage/dao.js';
import { openDb } from '../storage/db.js';
import { assertRoomName } from '../util/naming.js';

export interface MembersOpts {
  room: string;
  json?: boolean;
}

export async function runMembers(opts: MembersOpts): Promise<void> {
  assertRoomName(opts.room);
  const db = openDb();
  try {
    const members = dao.roomMembers(db, opts.room);

    if (opts.json) {
      process.stdout.write(`${JSON.stringify(members, null, 2)}\n`);
      return;
    }

    if (members.length === 0) {
      process.stdout.write(`(no members in ${opts.room})\n`);
      return;
    }

    for (const handle of members) {
      process.stdout.write(`  ${handle}\n`);
    }
  } finally {
    db.close();
  }
}
