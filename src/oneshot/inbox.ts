import * as dao from '../storage/dao.js';
import { openDb } from '../storage/db.js';
import { resolveHandle, timeOf } from './common.js';

export interface InboxOpts {
  handle?: string;
  peek?: boolean;
  json?: boolean;
}

export async function runInbox(opts: InboxOpts): Promise<void> {
  const handle = resolveHandle(opts.handle, '--handle');
  const db = openDb();
  try {
    const messages = dao.pendingInbox(db, { to: handle });
    if (!opts.peek && messages.length > 0) {
      const ids = messages.map((m) => m.id);
      dao.markRead(db, ids);
      dao.markDelivered(db, ids);
    }

    if (opts.json) {
      const wire = messages.map((m) => ({
        id: m.id,
        from: m.from_handle,
        body: m.body,
        sent_at: m.sent_at,
      }));
      process.stdout.write(`${JSON.stringify(wire, null, 2)}\n`);
      return;
    }

    if (messages.length === 0) {
      process.stdout.write('(no unread messages)\n');
      return;
    }

    for (const m of messages) {
      process.stdout.write(`[${m.from_handle} → ${handle} ${timeOf(m.sent_at)}]  ${m.body}\n`);
    }
  } finally {
    db.close();
  }
}
