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

/**
 * 🛑 APPROVED, AND THE TARGET STILL DID NOT MOVE.
 *
 * The third outcome, ruled by lee on 2026-10-31. A probe given exactly what
 * it asked for that still achieved nothing is the measurement #42 exists to
 * make, and the corpus had no word for it.
 *
 * 🛑 IT IS NOT `refused`. A refusal says the child was denied. This says
 * the child was ALLOWED and failed anyway, so filing it as `refused` would
 * answer "no, not under that grant" to a question whose measured answer is
 * "yes, and it did not work".
 */
export interface RefusedUnderGrantRecord {
  readonly outcome: 'refused_under_grant';
  /**
   * ⚠️ PLURAL. A probe can answer more than one approval before its target
   * is checked, and the existing records' singular `approvalId` is why a
   * two-grant run cannot be told from a one-grant run in anything already
   * written.
   */
  readonly approvalIds: readonly number[];
  readonly attempted: string;
  /**
   * 🛑 NEVER NULL. This record's whole claim is "under THIS set", so a row
   * that does not carry its set says nothing at all. The `refused` branch has
   * to tolerate null because rows predate the column; this outcome does not
   * exist before it.
   */
  readonly allowlist: readonly string[];
  readonly evidence: string;
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
  | { readonly kind: 'refused_under_grant'; readonly record: RefusedUnderGrantRecord }
  | { readonly kind: 'permitted'; readonly record: PermittedRecord }
  | { readonly kind: 'unknown'; readonly reason: string };

export type CorpusRecord = RefusedRecord | RefusedUnderGrantRecord | PermittedRecord;

// ⚠️ RESOLVED FROM THIS MODULE, NOT THE CWD. A relative path made the corpus
// load only when the suite ran from the package root.
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'captured-refusals.json');

const CORPUS: CorpusRecord[] = JSON.parse(readFileSync(FIXTURE, 'utf8'));

// 🛑 EVERY OUTCOME IS COUNTED. A third outcome absent from here could grow
// to any size without the number anyone reads changing.
export const corpusSize = (): {
  refused: number;
  refusedUnderGrant: number;
  permitted: number;
} => ({
  refused: CORPUS.filter((r) => r.outcome === 'refused').length,
  refusedUnderGrant: CORPUS.filter((r) => r.outcome === 'refused_under_grant').length,
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

/**
 * `corpus` exists so the three-outcome precedence can be proven against
 * records written here rather than against whatever the fixture happens to
 * hold. The corpus holds no `refused_under_grant` yet, and a branch only
 * reachable once a live run has spent money is a branch nothing checks.
 */
export function classify(
  attempted: string,
  allowed: readonly string[],
  corpus: readonly CorpusRecord[] = CORPUS,
): Verdict {
  const want = normalise(attempted);

  // 🛑 BOTH SIDES, OR NEITHER MATCHES. Normalising only the query left every
  // permit record unreachable: the stored key held a run's real scratch path
  // and the query had been collapsed to the captured spelling. The corpus
  // held five permits and the model could reach one. Found by claude1 on
  // PR 43, one commit after the same shape in the dedup.
  const grants = allowed.map((a) => normalise(a));

  /**
   * 🛑 EVERY EXACT-SET BRANCH COMES BEFORE THE CONTAINMENT BRANCH.
   *
   * `permitted` names ONE entry and matches by containment, so it only ever
   * asserts that entry is sufficient — an inference. `refused` and
   * `refused_under_grant` name the WHOLE set and match it exactly — a
   * measurement. When both describe the same command and the query IS that
   * set, the thing actually watched under it has to win, or the corpus
   * answers `permitted` for a command it saw fail.
   *
   * 🛑 THIS APPLIES TO BOTH, AND FOR ONE COMMIT IT APPLIED TO ONE. The rule
   * arrived with `refused_under_grant` and was not carried to `refused`
   * beside it, which matches on `sameSet` identically. Found by claude1, and
   * it is the fourth one-fix-two-sites instance of the day.
   *
   * ⚠️ It was LATENT, not live: 0 such pairs across 25 combinations in the
   * fixture, because all five recorded refusals ran under the probe
   * allowlist and it holds no granted entry. A probe denied TWICE is the path
   * to live — its second refusal is recorded with the first grant present.
   */
  for (const r of corpus) {
    if (r.outcome !== 'refused_under_grant' || normalise(r.attempted) !== want) continue;
    if (sameSet(r.allowlist.map((a) => normalise(a)), grants)) {
      return { kind: 'refused_under_grant', record: r };
    }
  }

  // 🛑 A REFUSAL IS ONLY A REFUSAL UNDER THE SAME ALLOWLIST. claude1 on PR
  // 43: ignoring it meant a refused command stayed refused even with a
  // correct grant present, so 14 of 15 records could never show a grant
  // working. A record whose allowlist was never recorded can only answer for
  // "nothing granted", which is why the N-of-N test passes an empty one —
  // that is the single case those rows are evidence for, not a fiction.
  for (const r of corpus) {
    if (r.outcome !== 'refused' || normalise(r.attempted) !== want) continue;

    // 🛑 A NULL ALLOWLIST IS NOT AN EMPTY ONE. Reading it as `[]` made a row
    // that recorded nothing return a positive `refused` for the "nothing
    // granted" query — the exact fiction this column was added to remove.
    // The only refusal whose allowlist was ever captured had FIVE entries,
    // so the unrecorded rows are not evidence for empty either.
    // Found by claude1 on PR 43, after I had claimed to have removed it.
    if (r.allowlist === null) continue;

    if (sameSet(r.allowlist.map((a) => normalise(a)), grants)) return { kind: 'refused', record: r };
  }

  // 🛑 A MEASURED SUCCESS NEEDS ITS ALLOWLIST ENTRY PRESENT. The same tool
  // was refused on approval 23 and permitted on approval 25; the command was
  // identical and only the allowlist differed. Keying on the command alone
  // would certify the exact defect that cost c7973ee.
  for (const r of corpus) {
    // ⚠️ THE STORED KEY NEEDS NORMALISING TOO. A capture harness writes the
    // run's real scratch path, so comparing it raw against a normalised query
    // never matches. I fixed the allowlist comparison and missed this one.
    if (r.outcome !== 'permitted' || normalise(r.attempted) !== want) continue;
    if (grants.includes(normalise(r.allowlistEntry))) return { kind: 'permitted', record: r };
  }

  return {
    kind: 'unknown',
    reason:
      `nothing in the corpus records attempting ${JSON.stringify(want)} under this ` +
      `allowlist (${grants.length} entries). Capture it from a live run rather ` +
      'than assuming it is allowed.',
  };
}
