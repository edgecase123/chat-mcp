import * as dao from '../storage/dao.js';
import { openDb } from '../storage/db.js';
import { timeOf } from './common.js';

export interface ListOpts {
  all?: boolean;
  json?: boolean;
}

export async function runList(opts: ListOpts): Promise<void> {
  const db = openDb();
  try {
    const agents = dao.listAgents(db, opts.all ?? false);

    if (opts.json) {
      const wire = agents.map((a) => ({
        handle: a.handle,
        display_name: a.display_name,
        kind: a.kind,
        online: a.online,
        last_seen_at: a.last_seen_at,
      }));
      process.stdout.write(`${JSON.stringify(wire, null, 2)}\n`);
      return;
    }

    if (agents.length === 0) {
      process.stdout.write(opts.all ? '(no known peers)\n' : '(no online peers)\n');
      return;
    }

    for (const a of agents) {
      const status = a.online ? 'online ' : 'offline';
      process.stdout.write(
        `  ${a.handle.padEnd(20)} ${a.kind.padEnd(8)} ${status}  seen ${timeOf(a.last_seen_at)}\n`,
      );
    }
  } finally {
    db.close();
  }
}
