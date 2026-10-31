/**
 * Merge the records of one outcome from the fixture and from a harness's
 * pending file, newest wins.
 *
 * 🛑 EXTRACTED BECAUSE THIS IS WHERE MEASUREMENTS GET LOST, and because the
 * third outcome made it a second copy. `rebuild-corpus.mjs` had this shape
 * inline for `permitted`; adding `refused_under_grant` beside it would be
 * two copies of the step that has already discarded a paid-for measurement
 * twice.
 *
 * 🛑 TEST INFRASTRUCTURE. Never import it from `src/`.
 */

export interface CarryOver<T> {
  /** The one outcome to keep. Anything else in either list is dropped. */
  readonly outcome: string;
  /** What makes two records the same measurement. */
  readonly keyOf: (record: T) => string;
  /** Records already in the fixture. */
  readonly existing: readonly (T | null | undefined)[];
  /** Records a harness wrote beside the fixture, not yet merged. */
  readonly pending: readonly (T | null | undefined)[];
}

export function carryOver<T extends { outcome: string }>(input: CarryOver<T>): T[] {
  const byKey = new Map<string, T>();

  // ⚠️ PENDING LAST, SO IT WINS. A fresh measurement losing to the row it was
  // taken to replace is how the dedup slip discarded the only record a live
  // run had produced.
  for (const record of [...input.existing, ...input.pending]) {
    // ⚠️ A HARNESS WROTE THE PENDING FILE, so a null is possible. Throwing
    // would abort the rebuild and take every valid record with it.
    if (!record || record.outcome !== input.outcome) continue;

    byKey.set(input.keyOf(record), record);
  }

  return [...byKey.values()];
}
