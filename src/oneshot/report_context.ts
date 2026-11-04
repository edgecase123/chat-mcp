import * as dao from '../storage/dao.js';
import { usedFromTranscript } from '../adapters/transcript-usage.js';
import { openDb } from '../storage/db.js';
import { notifyPeer } from '../notify/bus.js';
import { nextGaugeState, warningBody, deliveryFor, type Threshold } from '../shim/gauge.js';

export interface ReportContextOpts {
  handle: string;
  /** Pass this, or `fromTranscript`. */
  used?: number;
  /** A Claude Code transcript to read the live window size out of. */
  fromTranscript?: string;
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

  // 🛑 A TRANSCRIPT WITH NO USAGE REPORTS NOTHING. Falling back to a byte
  // estimate is the behaviour #103 removed: it read 100% on a window that
  // held 73.3%. An unknown gauge is honest; a guessed one gets acted on.
  const used = opts.fromTranscript !== undefined
    ? usedFromTranscript(opts.fromTranscript)
    : opts.used;

  if (used === null || used === undefined) {
    if (opts.fromTranscript !== undefined) return;
    throw new Error('--used or --from-transcript is required');
  }

  if (!Number.isInteger(used) || used < 0) {
    throw new Error(`--used must be a non-negative integer (got ${used})`);
  }
  if (!Number.isInteger(opts.total) || opts.total <= 0) {
    throw new Error(`--total must be a positive integer (got ${opts.total})`);
  }
  // A window genuinely larger than the configured total means `--total` is
  // stale — the model changed since `chat-mcp install` ran. Clamp rather than
  // refuse: a gauge pinned at 100% still says "full", and throwing inside a
  // PreToolUse hook would surface as a tool-call failure.
  const clamped = Math.min(used, opts.total);

  const db = openDb();
  try {
    const me = dao.getAgent(db, opts.handle);
    if (!me) {
      throw new Error(
        `Unknown handle: ${opts.handle}. The agent must have registered on the bus first.`,
      );
    }
    const prevWarned = (me.context_warned_threshold ?? null) as Threshold | null;
    dao.setAgentContext(db, opts.handle, clamped, opts.total);

    const percent = opts.total > 0 ? Math.round((clamped / opts.total) * 1000) / 10 : 0;
    const transition = nextGaugeState(percent, prevWarned);

    if (transition.next_warned !== prevWarned) {
      dao.setAgentContextWarned(db, opts.handle, transition.next_warned);
    }

    const notified = { dm: 0, rooms: [] as string[] };
    if (transition.fire != null) {
      const body = warningBody(opts.handle, transition.fire, percent);
      const delivery = deliveryFor(transition.fire);

      if (delivery === 'dm') {
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
          body,
          kind: 'chat',
        });
        notified.dm = 1;
      } else {
        const kind = delivery === 'alert' ? 'alert' : 'chat';
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
              body,
              kind,
            });
          }
          notified.rooms.push(room.name);
        }
      }
    }

    const payload = {
      handle: opts.handle,
      used: clamped,
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
