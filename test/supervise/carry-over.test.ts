import { test } from 'node:test';
import assert from 'node:assert/strict';
import { carryOver } from '../support/carry-over.js';

/**
 * 🛑 THIS IS WHERE MEASUREMENTS GET LOST.
 *
 * Two of the three "the run happened and the corpus missed it" incidents on
 * 2026-10-31 were in the merge, not the measurement. Once dedup kept a row
 * with no allowlist over a recorded one. Once nothing read the pending file
 * at all, and four permits that cost real money bought the fixture nothing.
 *
 * `rebuild-corpus.mjs` cannot be imported — it opens the live database and
 * rewrites the fixture on import — so the merge lives here as a pure
 * function and the script calls it.
 */

const permit = (attempted: string, entry: string) => ({
  outcome: 'permitted' as const,
  approvalId: 1,
  attempted,
  allowlistEntry: entry,
  evidence: 'HISTORICAL',
});

const keyOf = (r: { attempted: string; allowlistEntry?: string }) => `${r.attempted}|${r.allowlistEntry}`;

test('a pending record replaces an existing one with the same key', () => {
  const existing = [{ ...permit('rm x', 'Bash(rm x)'), approvalId: 1 }];
  const pending = [{ ...permit('rm x', 'Bash(rm x)'), approvalId: 2 }];

  const merged = carryOver({ outcome: 'permitted', keyOf, existing, pending });

  assert.equal(merged.length, 1);
  assert.equal(merged[0].approvalId, 2, 'the older record won, which is how a fresh measurement gets discarded');
});

test('records of a different outcome are left out', () => {
  const existing = [{ outcome: 'refused', approvalId: 9, attempted: 'rm x', allowlist: null, refusal: 'no' }];

  const merged = carryOver({ outcome: 'permitted', keyOf, existing, pending: [] });

  assert.deepEqual(merged, []);
});

test('two records with different keys both survive', () => {
  const merged = carryOver({
    outcome: 'permitted',
    keyOf,
    existing: [permit('rm x', 'Bash(rm x)')],
    pending: [permit('touch y', 'Bash(touch y)')],
  });

  assert.equal(merged.length, 2, 'a second distinct record was swallowed');
});

// ⚠️ A PENDING FILE IS WRITTEN BY A HARNESS AND CAN HOLD A NULL. Throwing here
// would abort the whole rebuild and take the valid records with it.
test('a null entry in the pending list does not take the rebuild down', () => {
  const merged = carryOver({
    outcome: 'permitted',
    keyOf,
    existing: [permit('rm x', 'Bash(rm x)')],
    pending: [null, permit('touch y', 'Bash(touch y)')],
  });

  assert.equal(merged.length, 2);
});

test('an empty merge returns an empty array rather than throwing', () => {
  assert.deepEqual(carryOver({ outcome: 'permitted', keyOf, existing: [], pending: [] }), []);
});
