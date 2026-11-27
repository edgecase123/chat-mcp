/**
 * 🛑 A HUNG RUN AND A GREEN RUN BOTH SHOW ZERO FAILURES.
 *
 * `node --test` prints its totals as the last thing it does. A run that never
 * reaches that block printed no failures either, so grepping for `fail` or
 * `not ok` reads a 15-hour hang as a clean sweep. That happened: pid 84590 sat
 * alive for 15h 22m having printed typecheck and format output and no verdict.
 *
 * So this parser REFUSES rather than defaults. A missing key throws; it never
 * returns zero for something it could not find.
 */

/** Every key the verdict needs. A block missing one is not a block. */
const REQUIRED = ["tests", "pass", "fail", "cancelled", "skipped", "todo"];

/**
 * Pull the totals out of a `node --test` spec-reporter transcript.
 *
 * Deliberately does NOT require the `ℹ` glyph: the same line arrives escaped
 * or entity-encoded depending on who piped it, and a glyph-anchored match
 * returns nothing while looking like a clean read.
 *
 * @throws when any required key is absent — that is the denominator guard.
 */
export function parseTestTotals(text) {
  const found = new Map();

  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\D*\b(tests|suites|pass|fail|cancelled|skipped|todo)\s+(\d+)\s*$/.exec(
      line,
    );
    // Last wins: two reporters are attached and both print a block.
    if (m) found.set(m[1], Number(m[2]));
  }

  const missing = REQUIRED.filter((k) => !found.has(k));
  if (missing.length > 0) {
    throw new Error(
      `no totals block in the test output — missing ${missing.join(", ")}. ` +
        `The run did not finish, so its silence about failures means nothing.`,
    );
  }

  return Object.fromEntries(REQUIRED.map((k) => [k, found.get(k)]));
}

/**
 * Rule the totals green or red.
 *
 * `cancelled` is the discriminator the grep-for-fail approach cannot see, so
 * it gets its own branch and its own sentence.
 */
export function verdictFor(totals) {
  const { tests, pass, fail, cancelled, skipped, todo } = totals;

  if (fail > 0) return { ok: false, reason: `${fail} failed` };

  if (cancelled > 0) {
    return {
      ok: false,
      reason: `${cancelled} cancelled — an aborted or hung run reports ZERO failures`,
    };
  }

  const accounted = pass + skipped + todo;
  if (accounted !== tests) {
    return {
      ok: false,
      reason: `the totals do not add up: pass+skipped+todo is ${accounted}, tests is ${tests}`,
    };
  }

  return { ok: true, reason: `${pass} of ${tests} passed` };
}
