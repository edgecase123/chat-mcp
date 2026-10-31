import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classify, corpusSize } from '../support/would-refuse.js';

/**
 * 🛑 THE THIRD OUTCOME: APPROVED, AND THE TARGET STILL DID NOT MOVE.
 *
 * The corpus had two words. `permitted` means a grant was present and the
 * target moved. `refused` means the child was denied. Neither fits a probe
 * that was given exactly what it asked for and still could nothing.
 *
 * Calling that `refused` is wrong in the dangerous direction: a later query
 * asking "is this allowed under that grant?" would be told no, when the
 * measured truth is "it was allowed and failed anyway".
 *
 * lee ruled on 2026-10-31 to add it.
 */

const CORPUS = JSON.parse(readFileSync('test/fixtures/captured-refusals.json', 'utf8')) as {
  outcome: string;
  attempted: string;
  allowlist?: string[] | null;
  approvalIds?: number[];
}[];

const COMMAND = 'touch /var/folders/T/e2e/work/compound-a.txt; touch /var/folders/T/e2e/work/compound-b.txt';

const UNDER_GRANT = {
  outcome: 'refused_under_grant' as const,
  approvalIds: [99],
  attempted: COMMAND,
  allowlist: ['Read', `Bash(${COMMAND})`],
  evidence:
    '2026-10-31: approved, and neither half of the compound appeared. ' +
    'HISTORICAL: the scratch directory is deleted when the run ends.',
};

test('a command that was approved and still did not work is refused_under_grant', () => {
  const v = classify(UNDER_GRANT.attempted, UNDER_GRANT.allowlist, [UNDER_GRANT]);

  assert.equal(v.kind, 'refused_under_grant');
});

// 🛑 THE DANGEROUS DIRECTION. `permitted` is the one answer this record must
// never produce, under any query, because the measurement says the opposite.
test('a refused_under_grant never answers permitted, whatever the query allowlist', () => {
  const queries = [[], ['Read'], UNDER_GRANT.allowlist, [...UNDER_GRANT.allowlist, 'Glob']];
  const wrong: string[] = [];

  for (const allowed of queries) {
    const v = classify(UNDER_GRANT.attempted, allowed, [UNDER_GRANT]);

    if (v.kind === 'permitted') wrong.push(JSON.stringify(allowed));
  }

  assert.deepEqual(wrong, [], `${wrong.length} of ${queries.length} queries answered permitted`);
});

/**
 * 🛑 AN EXACT SET MEASUREMENT BEATS A CONTAINMENT GUESS.
 *
 * A `permitted` record names ONE entry and is matched by containment, so it
 * asserts that entry is sufficient. A `refused_under_grant` names the whole
 * set and is matched exactly. When both describe the same command and the
 * query IS that set, the thing actually measured under it has to win.
 */
test('a refused_under_grant under the query set beats a permitted record for the same command', () => {
  const permitted = {
    outcome: 'permitted' as const,
    approvalId: 98,
    attempted: COMMAND,
    allowlistEntry: `Bash(${COMMAND})`,
    evidence: 'HISTORICAL: an earlier run.',
  };

  const v = classify(UNDER_GRANT.attempted, UNDER_GRANT.allowlist, [permitted, UNDER_GRANT]);

  assert.equal(v.kind, 'refused_under_grant', 'a containment guess outranked an exact measurement');
});

/**
 * 🛑 THE SAME RULE, ON THE OTHER EXACT-SET BRANCH.
 *
 * `refused` matches on `sameSet` exactly as `refused_under_grant` does, so it
 * belongs above the containment branch for the same reason. It was below it,
 * which is the one-fix-two-sites shape: the precedence rule was introduced
 * for the new outcome and not applied to the old one beside it.
 *
 * ⚠️ LATENT, NOT LIVE. Measured 0 such pairs across 25 combinations in the
 * fixture, because all five recorded refusals ran under the probe allowlist
 * and it holds no granted entry. The path to live is a probe denied TWICE:
 * its second refusal is recorded with the first grant already in the set.
 *
 * Found by claude1 on this PR.
 */
test('a refused measured under the query set beats a permitted record for the same command', () => {
  const command = 'git -C /var/folders/T/e2e/work tag v1';
  const allowlist = ['Read', `Bash(${command})`];

  const permitted = {
    outcome: 'permitted' as const,
    approvalId: 50,
    attempted: command,
    allowlistEntry: `Bash(${command})`,
    evidence: 'HISTORICAL: an earlier run under a different allowlist.',
  };

  const refused = {
    outcome: 'refused' as const,
    approvalId: 51,
    attempted: command,
    allowlist,
    refusal: 'denied a second time, with the first grant already present',
  };

  const v = classify(command, allowlist, [permitted, refused]);

  assert.equal(v.kind, 'refused', 'a containment guess outranked an exact measurement');
});

// ⚠️ AND AN UNRELATED ALLOWLIST STAYS SILENT. The record answers for the set
// it was measured under, not for every set that shares a command.
test('a refused_under_grant does not answer for an allowlist it was not measured under', () => {
  const v = classify(UNDER_GRANT.attempted, ['Read', 'Glob'], [UNDER_GRANT]);

  assert.equal(v.kind, 'unknown');
});

test('corpusSize reports the third outcome, so it cannot grow invisibly', () => {
  const size = corpusSize();

  assert.ok('refusedUnderGrant' in size, `the third outcome is absent from ${JSON.stringify(size)}`);
});

/**
 * 🛑 THE DENOMINATOR, STATED. Every test above injects its record, so none of
 * them is evidence that the corpus HOLDS one. This test exists to make the
 * zero explicit and to fail the moment a live run files the first real
 * record — at which point the N-of-N check below stops being vacuous.
 */
test('the corpus holds no refused_under_grant yet, so the branch is proven only by injection', () => {
  const rows = CORPUS.filter((r) => r.outcome === 'refused_under_grant');

  assert.equal(
    rows.length,
    0,
    `${rows.length} real record(s) now exist — this test has done its job, delete it`,
  );
});

test('every refused_under_grant in the corpus answers under its own allowlist', () => {
  const rows = CORPUS.filter((r) => r.outcome === 'refused_under_grant');
  const wrong: string[] = [];

  for (const r of rows) {
    const v = classify(r.attempted, r.allowlist ?? []);

    if (v.kind !== 'refused_under_grant') wrong.push(`${JSON.stringify(r.approvalIds)} -> ${v.kind}`);
  }

  assert.deepEqual(wrong, [], `${wrong.length} of ${rows.length} answered wrongly`);
});
