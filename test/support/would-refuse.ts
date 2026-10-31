import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  /**
   * What the child was allowed to use when it was refused.
   *
   * 🛑 NULL MEANS UNRECORDED. Those rows predate the column, and every one of
   * them had a non-empty allowlist nobody wrote down. Such a record can say
   * "this was refused with nothing granted"; it CANNOT say what happens under
   * a caller's own allowlist.
   */
  readonly allowlist: string[] | null;
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

// ⚠️ RESOLVED FROM THIS MODULE, NOT THE CWD. A relative path made the corpus
// load only when the suite ran from the package root.
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'captured-refusals.json');

const CORPUS: (RefusedRecord | PermittedRecord)[] = JSON.parse(readFileSync(FIXTURE, 'utf8'));

export const corpusSize = (): { refused: number; permitted: number } => ({
  refused: CORPUS.filter((r) => r.outcome === 'refused').length,
  permitted: CORPUS.filter((r) => r.outcome === 'permitted').length,
});

/**
 * The one transform applied before lookup: the RANDOM segments of a scratch
 * directory collapse, so a record can match a later run's fresh directory.
 *
 * 🛑 THE `/private` PREFIX SURVIVES. An earlier version mapped `/var/...` and
 * `/private/var/...` to one key, which erased the exact distinction that cost
 * `6cca826` — a grant that named one directory two ways. Found by claude1 on
 * PR 43, in the transform rather than the rules.
 */
export function normalise(command: string): string {
  return command
    .replace(/(\/private)?\/var\/folders\/\S+?\/chat-mcp-e2e-\w+/g, '$1/var/folders/T/e2e')
    .trim();
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;

  const left = [...a].sort();
  const right = [...b].sort();

  return left.every((v, i) => v === right[i]);
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

  // 🛑 A REFUSAL IS ONLY A REFUSAL UNDER THE SAME ALLOWLIST. claude1 on PR
  // 43: ignoring it meant a refused command stayed refused even with a
  // correct grant present, so 14 of 15 records could never show a grant
  // working. A record whose allowlist was never recorded can only answer for
  // "nothing granted", which is why the N-of-N test passes an empty one —
  // that is the single case those rows are evidence for, not a fiction.
  for (const r of CORPUS) {
    if (r.outcome !== 'refused' || r.attempted !== want) continue;

    // 🛑 A NULL ALLOWLIST IS NOT AN EMPTY ONE. Reading it as `[]` made a row
    // that recorded nothing return a positive `refused` for the "nothing
    // granted" query — the exact fiction this column was added to remove.
    // The only refusal whose allowlist was ever captured had FIVE entries,
    // so the unrecorded rows are not evidence for empty either.
    // Found by claude1 on PR 43, after I had claimed to have removed it.
    if (r.allowlist === null) continue;

    if (sameSet(r.allowlist, allowed)) return { kind: 'refused', record: r };
  }

  return {
    kind: 'unknown',
    reason:
      `nothing in the corpus records attempting ${JSON.stringify(want)} under this ` +
      `allowlist (${allowed.length} entries). Capture it from a live run rather ` +
      'than assuming it is allowed.',
  };
}
