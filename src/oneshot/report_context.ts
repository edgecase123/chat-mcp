import * as dao from '../storage/dao.js';
import { openDb } from '../storage/db.js';
import { notifyPeer } from '../notify/bus.js';
import { nextGaugeState, warningBody, type Threshold } from '../shim/gauge.js';

export interface ReportContextOpts {
  handle: string;
  used: number;
  total: number;
  json?: boolean;
}

/**
 * Bash-invokable equivalent of the report_context MCP tool. Used by the
 * Claude Code PreToolUse adapter hook to push an estimated gauge without
 * having to speak the MCP protocol from a hook script. The DB write, the
 * hysteresis state machine, and the threshold-warning fanout are shared
 * with the MCP tool — this is a thin CLI wrapper around the same code.
 */
export async function runReportContext(opts: ReportContextOpts): Promise<void> {
  if (!opts.handle) throw new Error('--handle is required');
  if (!Number.isInteger(opts.used) || opts.used < 0) {
    throw new Error(`--used must be a non-negative integer (got ${opts.used})`);
  }
  if (!Number.isInteger(opts.total) || opts.total <= 0) {
    throw new Error(`--total must be a positive integer (got ${opts.total})`);
  }
  if (opts.used > opts.total) {
    throw new Error(`--used (${opts.used}) must not exceed --total (${opts.total})`);
  }

  const db = openDb();
  try {
    const me = dao.getAgent(db, opts.handle);
    if (!me) {
      throw new Error(
        `Unknown handle: ${opts.handle}. The agent must have registered on the bus first.`,
      );
    }
    const prevWarned = (me.context_warned_threshold ?? null) as Threshold | null;
    dao.setAgentContext(db, opts.handle, opts.used, opts.total);

    const percent = opts.total > 0 ? Math.round((opts.used / opts.total) * 1000) / 10 : 0;
    const transition = nextGaugeState(percent, prevWarned);

    if (transition.next_warned !== prevWarned) {
      dao.setAgentContextWarned(db, opts.handle, transition.next_warned);
    }

    const notified = { dm: 0, rooms: [] as string[] };
    if (transition.fire != null) {
      const body = warningBody(opts.handle, transition.fire, percent);
      if (transition.fire === 70) {
        const result = dao.insertMessage(db, {
          from: dao.SYSTEM_HANDLE,
          to: opts.handle,
          body,
          kind: 'chat',
        });
        notifyPeer(opts.handle, {
          id: result.id,
          to: opts.handle,
          from: dao.SYSTEM_HANDLE,
          ts: result.sent_at,
        });
        notified.dm = 1;
      } else {
        const kind = transition.fire === 95 ? 'alert' : 'chat';
        for (const room of dao.myRooms(db, opts.handle)) {
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
            });
          }
          notified.rooms.push(room.name);
        }
      }
    }

    const payload = {
      handle: opts.handle,
      used: opts.used,
      total: opts.total,
      percent,
      warned: transition.next_warned,
      fired: transition.fire,
      notified,
    };
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(payload)}\n`);
    } else {
      const fired = transition.fire ? ` fired=${transition.fire}` : '';
      process.stdout.write(`gauge handle=${opts.handle} ${percent}%${fired}\n`);
    }
  } finally {
    db.close();
  }
}
