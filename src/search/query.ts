/**
 * Turning what an operator typed into a safe transcript query (#102).
 *
 * 🛑 A WRONG SEARCH RETURNS RESULTS, SO IT LOOKS LIKE IT WORKED. `LIKE` treats
 * `%` and `_` as wildcards, so an unescaped query silently matches far more
 * than was typed and the only symptom is a longer list.
 *
 * 🛑 FTS5 IS NOT AVAILABLE HERE, so this escaping is the whole correctness
 * story rather than a stopgap. Measured and recorded on #102:
 * `CREATE VIRTUAL TABLE t USING fts5(body)` fails with `no such module: fts5`
 * in `node:sqlite`. Revisiting it needs a different SQLite binding, not a
 * migration.
 *
 * 🛑 NOTHING HERE READS OR WRITES THE DATABASE. The watermark hazard #102
 * flags only exists for a search routed through `room_inbox`; this path never
 * touches `room_reads`, and `searchMessages` is tested for that.
 */

/** The most rows one search may return, however large a limit is asked for. */
export const MAX_LIMIT = 200;

const DEFAULT_LIMIT = 50;
const ESCAPE = '\\';

/**
 * A `LIKE` pattern matching the query as literal text.
 *
 * 🛑 THE BACKSLASH IS ESCAPED FIRST. Doing `%` and `_` before it turns `a\%b`
 * into `a\\%b`, where the backslash escapes the backslash and the `%` goes
 * back to being a wildcard — the exact bug this function exists to prevent,
 * reintroduced by the order of two lines.
 *
 * The caller must pair this with `ESCAPE '\'` in the SQL.
 */
export function likePattern(q: string): string {
  const literal = q
    .trim()
    .split(ESCAPE)
    .join(ESCAPE + ESCAPE)
    .split('%')
    .join(`${ESCAPE}%`)
    .split('_')
    .join(`${ESCAPE}_`);

  return `%${literal}%`;
}

export type ParsedSearch =
  | { readonly ok: false; readonly reason: string }
  | {
      readonly ok: true;
      readonly q: string;
      readonly pattern: string;
      readonly target?: string;
      readonly limit: number;
      /** A query short enough that the caller should say so beside the count. */
      readonly broad: boolean;
    };

export function parseSearch(input: {
  readonly q?: string;
  readonly target?: string;
  readonly limit?: number;
}): ParsedSearch {
  const q = (input.q ?? '').trim();

  // 🛑 A BLANK QUERY IS REFUSED. `%%` matches every row, and a search that
  // returns the whole transcript is indistinguishable from one that worked.
  if (q.length === 0) return { ok: false, reason: 'A search needs a term. A blank one would match every message.' };

  const target = input.target !== undefined && input.target.trim().length > 0 ? input.target.trim() : undefined;

  // Junk falls back rather than becoming zero — a zero limit returns nothing
  // and reads as "no matches".
  const asked = input.limit;
  const limit =
    typeof asked === 'number' && Number.isFinite(asked) && asked > 0 ? Math.min(Math.floor(asked), MAX_LIMIT) : DEFAULT_LIMIT;

  return { ok: true, q, pattern: likePattern(q), target, limit, broad: q.length < 3 };
}

/**
 * A window of the body around the match.
 *
 * 🛑 CENTRED ON THE MATCH, NOT THE HEAD. The messages worth finding are long,
 * and a head-slice snippet shows the greeting of every one of them.
 *
 * 🛑 CASE-INSENSITIVE, BECAUSE `LIKE` IS. SQLite's LIKE ignores ASCII case, so
 * a case-sensitive search here would centre on nothing for half the real
 * matches and silently fall back to the head.
 */
export function snippet(body: string, term: string, width: number): string {
  if (body.length <= width) return body;

  const at = body.toLowerCase().indexOf(term.trim().toLowerCase());
  // Not found means the match is outside this body, or a different case fold.
  // Returning the head is right; throwing would break a whole result page.
  const centre = at === -1 ? 0 : at;

  const start = Math.max(0, centre - Math.floor((width - term.length) / 2));
  const end = Math.min(body.length, start + width);
  const cut = body.slice(start, end);

  // ⚠️ THE MARKERS SAY IT IS A WINDOW. Without them a truncated message reads
  // as a short one, and an operator compares it against what they remember.
  return `${start > 0 ? '…' : ''}${cut}${end < body.length ? '…' : ''}`;
}
