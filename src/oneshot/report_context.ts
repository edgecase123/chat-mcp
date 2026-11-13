import * as dao from '../storage/dao.js';
import { usedFromTranscript } from '../adapters/transcript-usage.js';
import { openDb } from '../storage/db.js';
import { applyContextReport } from '../shim/gauge-report.js';

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
 * Bash-invokable equivalent of the report_context MCP tool, for the Claude
 * Code PreToolUse hook. The write, the hysteresis and the warning fanout are
 * `applyContextReport`; what lives here is this caller's own input policy.
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

    const report = applyContextReport(db, opts.handle, clamped, opts.total);

    if (opts.json) {
      process.stdout.write(`${JSON.stringify({ handle: opts.handle, ...report })}\n`);
    } else {
      const fired = report.fired ? ` fired=${report.fired}` : '';
      process.stdout.write(`gauge handle=${opts.handle} ${report.percent}%${fired}\n`);
    }
  } finally {
    db.close();
  }
}
