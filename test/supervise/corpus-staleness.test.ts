import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { corpusAge, maxAgeDays, RECAPTURE } from '../support/corpus-age.js';

/**
 * 🛑 THE CORPUS CAN GO WRONG WITHOUT CHANGING, AND #42 LEFT THAT UNOWNED.
 *
 * `test/fixtures/captured-refusals.json` answers "would the child refuse
 * this" by replaying what real children did on one day. A CLI change can make
 * a recorded refusal wrong. The fixture said nothing about when it was
 * recorded, so no test could tell a measurement from a memory.
 *
 * These tests are the signal. They fail loudly when the newest capture passes
 * the ceiling, and they name the command that fixes it.
 */

const CORPUS = JSON.parse(
  readFileSync(new URL('../fixtures/captured-refusals.json', import.meta.url), 'utf8'),
) as { capturedAt?: string; outcome: string; approvalId?: number }[];

test('🛑 every record says when it was captured', () => {
  const age = corpusAge(CORPUS, Date.now());

  // 🛑 THE DENOMINATOR IS THE POINT. A corpus where one record is stamped and
  // 25 are not would otherwise report a fresh age off the single stamp.
  assert.equal(
    age.unstamped,
    0,
    `${age.unstamped} of ${age.total} records carry no capturedAt, so the age is read off ${age.stamped}. Rebuild: ${RECAPTURE}`,
  );

  assert.equal(
    age.unparseable,
    0,
    `${age.unparseable} of ${age.total} records carry a capturedAt that does not parse`,
  );
});

test('🛑 no record is stamped in the future, which would read as permanent freshness', () => {
  const age = corpusAge(CORPUS, Date.now());

  // 🛑 NOT VACUOUS. `future === 0` is also true of a corpus nothing stamped,
  // so the count of usable stamps has to be asserted in the same test.
  assert.ok(age.stamped > 0, `no record carries a usable capturedAt, so "none in the future" says nothing. Rebuild: ${RECAPTURE}`);

  assert.equal(
    age.future,
    0,
    `${age.future} of ${age.total} records are stamped after now. An age check cannot see past a future stamp — check the clock that wrote them, not the corpus`,
  );
});

test('🛑 the OLDEST capture is inside the staleness ceiling', () => {
  // claude1 on PR 112: gating on the newest meant re-capturing ONE record
  // laundered the rest. Measured — 25 of 26 aged to 307 days with one left
  // fresh reported itself 1 day old and passed 5 of 5.
  const age = corpusAge(CORPUS, Date.now());
  const ceiling = maxAgeDays();

  assert.notEqual(age.oldest, null, `no record carries a usable capturedAt, so staleness is unmeasurable. Rebuild: ${RECAPTURE}`);

  assert.ok(
    (age.oldestAgeDays as number) <= ceiling,
    `the corpus's OLDEST record is ${age.oldestAgeDays} days old and the ceiling is ${ceiling} (its newest is ${age.newestAgeDays}). A corpus is only as fresh as its stalest replayed record. Re-capture: ${RECAPTURE}`,
  );
});

test('the age reader can actually see a stale corpus, so a pass means something', () => {
  // Without this, the test above passes just as well against a reader that
  // returns 0 for everything. Same positive control as gate-discovery's.
  const now = Date.parse('2026-11-04T00:00:00Z');

  const stale = corpusAge([{ capturedAt: '2026-01-01T00:00:00Z' }], now);
  assert.equal(stale.oldestAgeDays, 307);
  assert.equal(stale.stamped, 1);

  const fresh = corpusAge([{ capturedAt: '2026-11-03T00:00:00Z' }], now);
  assert.equal(fresh.oldestAgeDays, 1);

  const missing = corpusAge([{}, {}], now);
  assert.equal(missing.unstamped, 2);
  assert.equal(missing.oldest, null);
  assert.equal(missing.oldestAgeDays, null);

  const broken = corpusAge([{ capturedAt: 'last tuesday' }], now);
  assert.equal(broken.unparseable, 1);
  assert.equal(broken.oldest, null);

  const ahead = corpusAge([{ capturedAt: '2027-01-01T00:00:00Z' }], now);
  assert.equal(ahead.future, 1);
  assert.equal(ahead.newest, null, 'a future stamp must not become the newest reading');
  assert.equal(ahead.oldest, null, 'nor the oldest');
});

test('🛑 ONE fresh record cannot launder a stale corpus', () => {
  // This is claude1's control B, as a test. It is the whole point of the fix.
  const now = Date.parse('2026-11-04T00:00:00Z');
  const records = [
    ...Array.from({ length: 25 }, () => ({ capturedAt: '2026-01-01T00:00:00Z' })),
    { capturedAt: '2026-11-03T00:00:00Z' },
  ];

  const age = corpusAge(records, now);

  assert.equal(age.newestAgeDays, 1, 'the newest reading is still reported');
  assert.equal(age.oldestAgeDays, 307, 'and the ceiling reads THIS one');
  assert.ok(age.oldestAgeDays > maxAgeDays({}), 'a 307-day corpus must be over any sane ceiling');
});

test('a future outlier changes neither end of the range', () => {
  const now = Date.parse('2026-11-04T00:00:00Z');
  const mixed = corpusAge(
    [{ capturedAt: '2026-10-01T00:00:00Z' }, { capturedAt: '2026-11-01T00:00:00Z' }, { capturedAt: '2030-01-01T00:00:00Z' }],
    now,
  );

  assert.equal(mixed.newestAgeDays, 3);
  assert.equal(mixed.oldestAgeDays, 34);
  assert.equal(mixed.future, 1);
});

test('the ceiling is 30 days by default and an override must be a positive number', () => {
  assert.equal(maxAgeDays({}), 30);
  assert.equal(maxAgeDays({ CHAT_MCP_CORPUS_MAX_AGE_DAYS: '' }), 30);
  assert.equal(maxAgeDays({ CHAT_MCP_CORPUS_MAX_AGE_DAYS: '7' }), 7);

  // A junk override must not silently become zero, which would fail every run.
  assert.equal(maxAgeDays({ CHAT_MCP_CORPUS_MAX_AGE_DAYS: 'soon' }), 30);
  assert.equal(maxAgeDays({ CHAT_MCP_CORPUS_MAX_AGE_DAYS: '0' }), 30);
  assert.equal(maxAgeDays({ CHAT_MCP_CORPUS_MAX_AGE_DAYS: '-5' }), 30);
});
