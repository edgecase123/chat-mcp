import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newestUsedInLines, usedFromTranscript } from '../../src/adapters/transcript-usage.js';

/**
 * The sum itself is tested beside the function, in
 * `test/supervise/drivers/claude-context.test.ts`. This file covers reading it
 * back out of a transcript FILE.
 *
 * #103 — the gauge used to be `wc -c` on the transcript divided by 3.5.
 * Measured on a live session 2026-11-04: 2,130,804 estimated against 732,973
 * actual, clamped to a 1,000,000 ceiling, so it reported 100% on a window at
 * 73.3%.
 */

function entry(usage: Record<string, number>): string {
  return JSON.stringify({ type: 'assistant', message: { usage } });
}

function tmpTranscript(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'chatmcp-transcript-'));
  const path = join(dir, 'session.jsonl');
  writeFileSync(path, lines.join('\n'));
  return path;
}

test('the NEWEST usage wins, not the first or the largest', () => {
  const lines = [
    entry({ input_tokens: 900000 }),
    entry({ input_tokens: 10 }),
  ];

  assert.equal(newestUsedInLines(lines), 10, 'an older, larger turn was taken instead of the newest');
});

test('lines with no usage are skipped, not treated as zero', () => {
  const lines = [
    entry({ input_tokens: 500 }),
    JSON.stringify({ type: 'user', message: { content: 'hello' } }),
    '',
  ];

  assert.equal(newestUsedInLines(lines), 500);
});

/**
 * The hook fires on every tool call against a file being appended to, so the
 * last line is routinely a partial write. A throw here would surface as a
 * failed tool call.
 */
test('a truncated final line is skipped rather than throwing', () => {
  const lines = [entry({ input_tokens: 42 }), '{"message":{"usa'];

  assert.equal(newestUsedInLines(lines), 42);
});

test('no usage anywhere returns null, which is not zero', () => {
  assert.equal(newestUsedInLines([JSON.stringify({ type: 'user' })]), null);
  assert.equal(newestUsedInLines([]), null);
});

/**
 * 🛑 NULL MUST NOT COLLAPSE INTO A NUMBER. Reporting 0 would read as "this
 * agent has an empty window", which is the opposite of "unknown" and is
 * exactly the kind of confident wrong answer #103 exists to remove.
 */
test('a zero-token usage block is treated as no reading', () => {
  assert.equal(newestUsedInLines([entry({ input_tokens: 0 })]), null);
});

test('reads the newest usage out of a real file', () => {
  const path = tmpTranscript([entry({ input_tokens: 10 }), entry({ cache_read_input_tokens: 777 })]);

  assert.equal(usedFromTranscript(path), 777);
});

test('a missing file returns null rather than throwing', () => {
  assert.equal(usedFromTranscript('/no/such/transcript.jsonl'), null);
});

/**
 * The tail read is why this is affordable on every tool call. With a window
 * smaller than the file, the scan starts mid-line — that fragment must not
 * break the parse.
 */
test('a tail that starts mid-line still finds the newest usage', () => {
  const path = tmpTranscript([
    entry({ input_tokens: 111111 }),
    entry({ input_tokens: 222 }),
  ]);

  // Small enough that the first entry is cut in half.
  assert.equal(usedFromTranscript(path, 80), 222);
});

/**
 * The cut can land inside the newest entry too. Then there is no complete
 * usage line in the window, and unknown is the correct answer — not the older
 * entry, which the tail does not contain either.
 */
test('a tail too small to hold any whole entry returns null', () => {
  const path = tmpTranscript([entry({ input_tokens: 111111 }), entry({ input_tokens: 222 })]);

  assert.equal(usedFromTranscript(path, 10), null);
});
