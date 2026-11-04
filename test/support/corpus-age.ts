/**
 * How old the replayed refusal corpus is.
 *
 * 🛑 TEST INFRASTRUCTURE. Never import it from `src/`.
 *
 * 🛑 A REPLAYED CAPTURE GOES STALE SILENTLY, and that is the one item #42
 * named as nobody's. The corpus answers "would the child refuse this" from
 * what real children did on a given day. A CLI change can make a recorded
 * refusal wrong, and nothing about the fixture says when it was recorded, so
 * nothing can say it has drifted.
 *
 * 🛑 A FUTURE STAMP DEFEATS AN AGE CHECK AND LOOKS LIKE FRESHNESS. It is
 * reported separately from a missing one, because the remedy differs: a
 * missing stamp needs a rebuild, a future stamp means a clock is wrong.
 *
 * 🛑 AGE IS THE OLDEST RECORD, NEVER THE NEWEST. A corpus is only as fresh as
 * its stalest replayed record, because any record can be the one that answers
 * a query. An earlier version gated on the newest, so re-capturing ONE record
 * laundered the other 25 — measured by claude1 on PR 112: 25 records aged to
 * 307 days with one left fresh reported itself 1 day old and passed.
 */

import type { Captured } from './would-refuse.js';

export interface CorpusAge {
  /** Records carrying a usable stamp. */
  readonly stamped: number;
  /** Records with no `capturedAt` at all. */
  readonly unstamped: number;
  /** Records whose `capturedAt` does not parse. */
  readonly unparseable: number;
  /** Records stamped after `now`. */
  readonly future: number;
  /** Every record, so a caller can print its own denominator. */
  readonly total: number;
  /** Epoch ms of the newest usable, non-future stamp, or null if none. */
  readonly newest: number | null;
  /** Epoch ms of the OLDEST usable, non-future stamp, or null if none. */
  readonly oldest: number | null;
  /**
   * Whole days between the OLDEST stamp and `now`, or null if there is none.
   *
   * 🛑 OLDEST, AND THE NAME SAYS SO. A bare `ageDays` read as "how old is this
   * corpus" and answered with its freshest record.
   */
  readonly oldestAgeDays: number | null;
  /** Whole days to the NEWEST stamp. For reporting, never for a ceiling. */
  readonly newestAgeDays: number | null;
}

const MS_PER_DAY = 86_400_000;

/**
 * Read `capturedAt` off every record and report the spread.
 *
 * ⚠️ IT RETURNS COUNTS RATHER THAN THROWING. The caller is a test, and a test
 * that cannot name how many records it covered is the failure claude1 found on
 * PR 43 — a probe over 3 of 7 records that read as certifying the model.
 */
export function corpusAge(records: readonly Captured[], now: number): CorpusAge {
  let unstamped = 0;
  let unparseable = 0;
  let future = 0;
  let newest: number | null = null;
  let oldest: number | null = null;

  for (const r of records) {
    if (typeof r.capturedAt !== 'string' || r.capturedAt === '') {
      unstamped += 1;
      continue;
    }

    const at = Date.parse(r.capturedAt);

    if (Number.isNaN(at)) {
      unparseable += 1;
      continue;
    }

    if (at > now) {
      future += 1;
      continue;
    }

    if (newest === null || at > newest) newest = at;
    if (oldest === null || at < oldest) oldest = at;
  }

  return {
    stamped: records.length - unstamped - unparseable - future,
    unstamped,
    unparseable,
    future,
    total: records.length,
    newest,
    oldest,
    oldestAgeDays: oldest === null ? null : Math.floor((now - oldest) / MS_PER_DAY),
    newestAgeDays: newest === null ? null : Math.floor((now - newest) / MS_PER_DAY),
  };
}

/**
 * The ceiling, in days, before the corpus is treated as stale.
 *
 * 🛑 THIRTY IS NOT ARBITRARY. The context gauge sat frozen for 28 days and
 * neither agent noticed (#108), so a month is the measured length of time this
 * project can carry a dead reading without seeing it.
 *
 * ⚠️ THE OVERRIDE EXISTS SO A RED CORPUS CANNOT BLOCK AN UNRELATED FIX. It is
 * an escape hatch for one run, not a way to retire the signal.
 */
export function maxAgeDays(env: Record<string, string | undefined> = process.env): number {
  const raw = env.CHAT_MCP_CORPUS_MAX_AGE_DAYS;

  if (raw === undefined || raw === '') return 30;

  const n = Number(raw);

  return Number.isFinite(n) && n > 0 ? n : 30;
}

/** The command that fixes a stale corpus, quoted in failure messages. */
export const RECAPTURE = [
  'CHAT_MCP_LIVE=1 node --import tsx scripts/capture-refusals.mjs',
  'node --import tsx scripts/rebuild-corpus.mjs',
].join(' && ');
