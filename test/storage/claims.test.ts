import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../../src/storage/db.js';
import * as dao from '../../src/storage/dao.js';
import { decideClaim, decideRelease } from '../../src/claims/lifecycle.js';

/**
 * 🛑 THE TABLE KEEPS HISTORY, AND THAT IS THE POINT.
 *
 * "Who held the gate when this broke" is unanswerable from a table that only
 * remembers the current holder, and that question is why #101 exists. So a
 * claim is a ROW, a release marks it, and a takeover appends rather than
 * overwriting.
 */

const NOW = Date.parse('2026-11-04T12:00:00Z');
const TTL = 240;

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  migrate(db);

  return db;
}

/** Claim through the same path a tool takes: decide, then store. */
function claim(db: DatabaseSync, resource: string, holder: string, now: number) {
  const existing = dao.latestClaim(db, resource);
  const d = decideClaim({ existing, resource, holder, now, ttlMinutes: TTL });

  if (d.outcome === 'conflict') return d;
  if (d.outcome === 'renewed' && existing) {
    dao.renewClaim(db, existing.id, d.expires_at as number);

    return d;
  }
  dao.insertClaim(db, { resource, holder, note: null, claimed_at: now, expires_at: d.expires_at as number });

  return d;
}

test('🛑 the migration creates the table, so a fresh database can hold a claim', () => {
  // Without this, every assertion below would fail with "no such table" and
  // read as a logic defect rather than a missing migration.
  const db = freshDb();

  assert.deepEqual(dao.liveClaims(db, NOW), []);
  assert.equal(dao.latestClaim(db, 'anything'), null);
});

test('a claim is readable straight back, with its holder and expiry', () => {
  const db = freshDb();

  const row = dao.insertClaim(db, {
    resource: 'reset-and-test.sh',
    holder: 'claude1',
    note: 'full gate, mode=all',
    claimed_at: NOW,
    expires_at: NOW + 1000,
  });

  assert.equal(row.holder, 'claude1');
  assert.equal(row.note, 'full gate, mode=all');
  assert.equal(row.released_at, null);
  assert.deepEqual(dao.liveClaims(db, NOW).map((c) => c.resource), ['reset-and-test.sh']);
});

test('🛑 a second agent is REFUSED and no row is written', () => {
  const db = freshDb();
  claim(db, 'reset-and-test.sh', 'claude1', NOW);

  const d = claim(db, 'reset-and-test.sh', 'claude2', NOW + 1000);

  assert.equal(d.outcome, 'conflict');
  assert.equal(d.heldBy, 'claude1');

  // The denominator matters: a conflict that still inserted would leave two
  // live claims and the panel would show both as held.
  const all = db.prepare('SELECT COUNT(*) AS n FROM claims').get() as unknown as { n: number };
  assert.equal(all.n, 1, 'a refused claim must write nothing');
});

test('a renewal extends the SAME row, so claimed_at still says when the hold began', () => {
  const db = freshDb();
  claim(db, 'leagues_app', 'claude1', NOW);
  const before = dao.latestClaim(db, 'leagues_app');

  claim(db, 'leagues_app', 'claude1', NOW + 60_000);
  const after = dao.latestClaim(db, 'leagues_app');

  assert.equal(after?.id, before?.id, 'a renewal must not append a row');
  assert.equal(after?.claimed_at, NOW, 'the original hold time survives');
  assert.ok((after?.expires_at as number) > (before?.expires_at as number));

  const all = db.prepare('SELECT COUNT(*) AS n FROM claims').get() as unknown as { n: number };
  assert.equal(all.n, 1);
});

test('a released resource is claimable, and BOTH rows survive', () => {
  const db = freshDb();
  claim(db, 'leagues_app', 'claude1', NOW);
  const held = dao.latestClaim(db, 'leagues_app');

  assert.equal(dao.releaseClaim(db, held?.id as number, NOW + 10), true);
  assert.deepEqual(dao.liveClaims(db, NOW + 20), []);

  const d = claim(db, 'leagues_app', 'claude2', NOW + 30);
  assert.equal(d.outcome, 'granted');
  assert.equal(d.tookOverFrom, undefined, 'a clean release is not a takeover');

  const all = db.prepare('SELECT COUNT(*) AS n FROM claims ORDER BY id').get() as unknown as { n: number };
  assert.equal(all.n, 2, 'the history is the point — a handover keeps both rows');
});

test('releasing twice reports false the second time', () => {
  const db = freshDb();
  claim(db, 'leagues_app', 'claude1', NOW);
  const id = dao.latestClaim(db, 'leagues_app')?.id as number;

  assert.equal(dao.releaseClaim(db, id, NOW + 10), true);
  assert.equal(dao.releaseClaim(db, id, NOW + 20), false, 'a second release did nothing and must say so');
});

test('🛑 an EXPIRED claim is taken over, and the takeover names who never released', () => {
  const db = freshDb();
  claim(db, 'reset-and-test.sh', 'claude1', NOW);

  const later = NOW + TTL * 60_000 + 1;
  assert.deepEqual(dao.liveClaims(db, later), [], 'the failsafe freed it');

  const d = claim(db, 'reset-and-test.sh', 'claude2', later);
  assert.equal(d.outcome, 'granted');
  assert.equal(d.tookOverFrom, 'claude1');
});

test('🛑 liveClaims reports the NEWEST row per resource, never a superseded one', () => {
  // Without the per-resource MAX(id), a handover would show the old holder
  // alongside the new one and the panel would name two holders for one thing.
  const db = freshDb();
  claim(db, 'leagues_app', 'claude1', NOW);
  dao.releaseClaim(db, dao.latestClaim(db, 'leagues_app')?.id as number, NOW + 10);
  claim(db, 'leagues_app', 'claude2', NOW + 20);

  const live = dao.liveClaims(db, NOW + 30);
  assert.equal(live.length, 1);
  assert.equal(live[0]?.holder, 'claude2');
});

test('two different resources are held independently', () => {
  const db = freshDb();

  assert.equal(claim(db, 'reset-and-test.sh', 'claude1', NOW).outcome, 'granted');
  assert.equal(claim(db, 'leagues_app', 'claude2', NOW).outcome, 'granted');

  assert.deepEqual(
    dao.liveClaims(db, NOW).map((c) => `${c.resource}:${c.holder}`).sort(),
    ['leagues_app:claude2', 'reset-and-test.sh:claude1'],
  );
});

test('a non-holder release leaves the row held', () => {
  const db = freshDb();
  claim(db, 'reset-and-test.sh', 'claude1', NOW);
  const existing = dao.latestClaim(db, 'reset-and-test.sh');

  const d = decideRelease({ existing, by: 'claude2', force: false, now: NOW + 10 });
  assert.equal(d.outcome, 'not-yours');

  // The decision refused, so nothing was stored. The claim is still live.
  assert.equal(dao.liveClaims(db, NOW + 10).length, 1);
});
