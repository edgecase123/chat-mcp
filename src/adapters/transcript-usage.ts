import { openSync, readSync, fstatSync, closeSync } from 'node:fs';
// `adapters/` may import from `supervise/`; the reverse is the banned edge.
import { usedFromUsage, type ClaudeUsage } from '../supervise/drivers/claude-events.js';

/**
 * How many tokens an agent's context window actually holds, read from the
 * transcript the client writes.
 *
 * 🛑 THIS REPLACES A BYTE COUNT THAT WAS WRONG BY 2.9x. The adapter used to do
 * `wc -c` on the transcript and divide by 3.5. That is cumulative history, not
 * live context: every tool result ever written counts forever, and a `/clear`
 * does not reduce it. Measured 2026-11-04 on a live session — 7,457,817 bytes
 * estimated 2,130,804 tokens and clamped to a 1,000,000 ceiling, reporting
 * 100%, while the window genuinely held 732,973 (73.3%).
 *
 * Every assistant turn in the JSONL carries what the model was actually sent:
 *
 *   input_tokens + cache_read_input_tokens + cache_creation_input_tokens
 *
 * The newest such turn IS the live size, so this needs no reset logic — after
 * a `/clear` the next turn's cache read is small and the figure falls on its
 * own.
 */

/**
 * The newest usage total in a block of transcript lines, or null.
 *
 * Scans BACKWARDS and stops at the first hit, because the newest turn is the
 * answer and the rest of the file is history.
 *
 * 🛑 A MALFORMED LINE IS SKIPPED, NOT FATAL. This runs inside a PreToolUse
 * hook on every tool call, and the last line of a file being appended to is
 * routinely a partial write.
 */
export function newestUsedInLines(lines: string[]): number | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line === undefined || line.length === 0) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    const usage = (parsed as { message?: { usage?: ClaudeUsage } })?.message?.usage;
    if (!usage) continue;

    const used = usedFromUsage(usage);
    if (used > 0) return used;
  }

  return null;
}

/**
 * How much of the tail to read. The hook fires on EVERY tool call, so reading
 * a 7 MB transcript each time is not acceptable — and the answer is always in
 * the last few entries anyway.
 *
 * 512 KB is roughly the last few turns at observed entry sizes. Too small and
 * a single large tool result pushes the newest usage out of the window, which
 * reads as "unknown" rather than as a wrong number.
 */
export const TAIL_BYTES = 512 * 1024;

/**
 * Read the live context size from a transcript file, or null when it cannot be
 * determined.
 *
 * 🛑 NULL IS A REAL ANSWER AND MUST NOT BECOME A NUMBER. A gauge that guesses
 * when it does not know is what this whole change exists to remove. The caller
 * reports nothing rather than reporting an estimate.
 */
export function usedFromTranscript(path: string, tailBytes = TAIL_BYTES): number | null {
  let fd: number | undefined;

  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const length = Math.min(size, tailBytes);
    const start = size - length;
    const buf = Buffer.alloc(length);

    readSync(fd, buf, 0, length, start);

    // A tail that starts mid-line leaves a fragment first; it fails to parse
    // and is skipped by the scan above, so no special case is needed.
    return newestUsedInLines(buf.toString('utf8').split('\n'));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
