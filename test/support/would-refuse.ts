import { readFileSync } from 'node:fs';

/**
 * What a real child did when it attempted something, read from a record of
 * what real children actually did.
 *
 * 🛑 TEST INFRASTRUCTURE. Never import it from `src/`.
 *
 * 🛑 THE VERDICT IS LOOKED UP, NOT DECIDED. The first version of this file
 * replayed captured WORDS on top of hand-written rules, and claude1 showed
 * it answered 5 of 7 captures wrongly with the counter-evidence sitting in
 * the same fixture. lee's replay ruling exists because the author's
 * DECISIONS about this CLI were wrong five times in one day — the wording
 * was never in doubt. So nothing here decides anything.
 *
 * 🛑 THERE IS NO "PERMITTED BY DEFAULT". The corpus is a record of refusals
 * plus exactly one measured success, so the absence of a refusal is not
 * evidence of permission. Anything unrecognised is `unknown`, and a caller
 * must treat that as a failure.
 */
export interface RefusedRecord {
  readonly outcome: 'refused';
  readonly approvalId: number;
  readonly attempted: string;
  readonly refusal: string;
}

export interface PermittedRecord {
  readonly outcome: 'permitted';
  readonly approvalId: number;
  readonly attempted: string;
  readonly allowlistEntry: string;
  readonly evidence: string;
}

export type Verdict =
  | { readonly kind: 'refused'; readonly record: RefusedRecord }
  | { readonly kind: 'permitted'; readonly record: PermittedRecord }
  | { readonly kind: 'unknown'; readonly reason: string };

const CORPUS: (RefusedRecord | PermittedRecord)[] = JSON.parse(
  readFileSync('test/fixtures/captured-refusals.json', 'utf8'),
);

export const corpusSize = (): { refused: number; permitted: number } => ({
  refused: CORPUS.filter((r) => r.outcome === 'refused').length,
  permitted: CORPUS.filter((r) => r.outcome === 'permitted').length,
});

/**
 * The one transform applied before lookup: scratch temp paths collapse to the
 * spelling the corpus was captured with. Every run gets a fresh directory, so
 * without it no record would ever match a live attempt.
 */
function normalise(command: string): string {
  return command
    .replace(/\/private\/var\/folders\/\S+?\/chat-mcp-e2e-\w+/g, '/tmp/e2e')
    .replace(/\/var\/folders\/\S+?\/chat-mcp-e2e-\w+/g, '/tmp/e2e')
    .trim();
}

export function classify(attempted: string, allowed: readonly string[]): Verdict {
  const want = normalise(attempted);

  // 🛑 A MEASURED SUCCESS NEEDS ITS ALLOWLIST ENTRY PRESENT. The same tool
  // was refused on approval 23 and permitted on approval 25; the command was
  // identical and only the allowlist differed. Keying on the command alone
  // would certify the exact defect that cost c7973ee.
  for (const r of CORPUS) {
    if (r.outcome !== 'permitted' || r.attempted !== want) continue;
    if (allowed.includes(r.allowlistEntry)) return { kind: 'permitted', record: r };
  }

  for (const r of CORPUS) {
    if (r.outcome === 'refused' && r.attempted === want) return { kind: 'refused', record: r };
  }

  return {
    kind: 'unknown',
    reason:
      `nothing in the corpus records attempting ${JSON.stringify(want)}. ` +
      'Capture it from a live run rather than assuming it is allowed.',
  };
}
