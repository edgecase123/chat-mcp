import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrate, type Db } from '../../src/storage/db.js';
import * as dao from '../../src/storage/dao.js';
import { decideClaim } from '../../src/claims/lifecycle.js';
import { performClaim } from '../../src/shim/tools/claims.js';

/**
 * 🛑 TWO AGENTS BOTH GOT `granted`, AND THE PANEL NAMED ONE OF THEM.
 *
 * `claim` READ the newest row and then WROTE a new one, with nothing holding
 * the resource in between. Two agents claiming together both read "free", both
 * passed `decideClaim`, and both inserted — so the table held two live rows
 * while `liveClaims` reported one. The holder that lost the display still
 * believed it owned the gate. Found by claude1 reviewing this branch.
 *
 * ⚠️ NO CONSTRAINT CAN EXPRESS THIS. "One live claim per resource" is partly a
 * statement about the clock, and a unique index cannot read `now`. So the
 * guard has to be in the write, as a compare-and-swap.
 *
 * Same shape, same remedy and the same reason as the `agents` table in
 * `claim-atomicity.test.ts` — see `writeClaim`.
 */

const R = 'reset-and-test.sh';
const NOW = Date.parse('2026-11-04T12:00:00Z');
const TTL = 240;

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  migrate(db);

  return db;
}

const holders = (db: DatabaseSync, now: number) => dao.liveClaims(db, now).map((c) => c.holder);

/**
 * 🛑 THE WINDOW IS OPENED BY HAND, BECAUSE NOTHING OUTSIDE THE TOOL CAN OPEN
 * IT. Both reads land before either write, which is exactly the interleaving a
 * single-threaded test would otherwise never produce.
 */
test('two agents that both read a FREE resource must not both end up holding it', () => {
  const db = freshDb();

  const seenByA = dao.latestClaim(db, R);
  const seenByB = dao.latestClaim(db, R);

  const a = decideClaim({ existing: seenByA, resource: R, holder: 'claude1', now: NOW, ttlMinutes: TTL });
  const b = decideClaim({ existing: seenByB, resource: R, holder: 'claude2', now: NOW, ttlMinutes: TTL });

  // Both decisions are `granted` and neither is wrong. The window is the bug,
  // not the decision, so the write is where it has to be closed.
  assert.equal(a.outcome, 'granted');
  assert.equal(b.outcome, 'granted');

  const first = dao.insertClaim(db, {
    resource: R,
    holder: 'claude1',
    note: null,
    claimed_at: NOW,
    expires_at: a.expires_at as number,
  });
  const second = dao.insertClaim(db, {
    resource: R,
    holder: 'claude2',
    note: null,
    claimed_at: NOW,
    expires_at: b.expires_at as number,
  });

  assert.notEqual(first, null, 'the first claimant was refused');
  assert.equal(second, null, 'the second write landed, so both agents hold the gate');
  assert.deepEqual(holders(db, NOW), ['claude1']);
});

/** A free resource still has to be claimable, or the guard has eaten the feature. */
test('a single claimant is still granted, so the guard refuses only a rival', () => {
  const db = freshDb();

  const row = dao.insertClaim(db, {
    resource: R,
    holder: 'claude1',
    note: 'full gate',
    claimed_at: NOW,
    expires_at: NOW + 1000,
  });

  assert.notEqual(row, null);
  assert.deepEqual(holders(db, NOW), ['claude1']);
});

/** An expired claim is debris, and taking it over is a grant, not a conflict. */
test('an EXPIRED claim does not block the insert, so a takeover still lands', () => {
  const db = freshDb();
  dao.insertClaim(db, { resource: R, holder: 'claude1', note: null, claimed_at: NOW, expires_at: NOW + 100 });

  const taken = dao.insertClaim(db, {
    resource: R,
    holder: 'claude2',
    note: null,
    claimed_at: NOW + 200,
    expires_at: NOW + 1200,
  });

  assert.notEqual(taken, null, 'the failsafe freed it and the guard refused anyway');
  assert.deepEqual(holders(db, NOW + 200), ['claude2']);
});

/** A released claim is a clean handover, and the guard must not outlive it. */
test('a RELEASED claim does not block the insert', () => {
  const db = freshDb();
  const held = dao.insertClaim(db, {
    resource: R,
    holder: 'claude1',
    note: null,
    claimed_at: NOW,
    expires_at: NOW + 10_000,
  });
  dao.releaseClaim(db, held?.id as number, NOW + 10);

  assert.notEqual(dao.insertClaim(db, {
    resource: R,
    holder: 'claude2',
    note: null,
    claimed_at: NOW + 20,
    expires_at: NOW + 10_000,
  }), null);
  assert.deepEqual(holders(db, NOW + 30), ['claude2']);
});

/**
 * 🛑 THE RENEWAL PATH HAD THE SAME WINDOW AND CLAUDE1'S REVIEW DID NOT NAME IT.
 *
 * A renewal is an UPDATE by id. Between reading its own live claim and writing
 * the new expiry, the claim can lapse and a rival can take it over — and the
 * stale UPDATE then revives the dead row. Two live rows, with an atomic insert
 * already in place.
 */
test('a STALE renewal cannot revive a claim that has since been taken over', () => {
  const db = freshDb();
  const mine = dao.insertClaim(db, {
    resource: R,
    holder: 'claude1',
    note: null,
    claimed_at: NOW,
    expires_at: NOW + 1000,
  });

  // claude1 reads its own live claim here and decides `renewed`. The write has
  // not landed yet.
  const LAPSED = NOW + 2000;
  assert.notEqual(
    dao.insertClaim(db, {
      resource: R,
      holder: 'claude2',
      note: null,
      claimed_at: LAPSED,
      expires_at: LAPSED + 1000,
    }),
    null,
  );

  const renewed = dao.renewClaim(db, {
    id: mine?.id as number,
    holder: 'claude1',
    expires_at: LAPSED + 5000,
    now: LAPSED,
  });

  assert.equal(renewed, null, 'a dead claim was revived under the new holder');
  assert.deepEqual(holders(db, LAPSED + 10), ['claude2']);
});

/** The renewal that is not stale still has to work — it happens on every retry. */
test('a renewal of a claim that is still live and still mine succeeds', () => {
  const db = freshDb();
  const mine = dao.insertClaim(db, {
    resource: R,
    holder: 'claude1',
    note: null,
    claimed_at: NOW,
    expires_at: NOW + 10_000,
  });

  const renewed = dao.renewClaim(db, {
    id: mine?.id as number,
    holder: 'claude1',
    expires_at: NOW + 20_000,
    now: NOW + 100,
  });

  assert.equal(renewed?.id, mine?.id, 'a renewal must not append a row');
  assert.equal(renewed?.claimed_at, NOW, 'the original hold time survives');
  assert.equal(renewed?.expires_at, NOW + 20_000);
});

/**
 * 🛑 IF TWO LIVE ROWS EVER EXIST, THE PANEL SHOWS BOTH.
 *
 * The old `MAX(id)` subquery named one holder and reported no conflict, which
 * is worse than the chat scrollback it replaced — that at least showed both
 * posts. Built with raw SQL because the DAO now refuses to create this state.
 */
test('liveClaims reports BOTH holders rather than hiding one behind MAX(id)', () => {
  const db = freshDb();
  db.prepare('INSERT INTO claims (resource, holder, note, claimed_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(R, 'claude1', null, NOW, NOW + 10_000);
  db.prepare('INSERT INTO claims (resource, holder, note, claimed_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(R, 'claude2', null, NOW, NOW + 10_000);

  assert.deepEqual(holders(db, NOW).sort(), ['claude1', 'claude2']);
});

/**
 * 🛑 THE REFUSAL HAS TO REACH THE CALLER. A `null` nobody checks is the
 * original bug with extra steps, so the tool's own branch is tested.
 *
 * ⚠️ THE WINDOW CANNOT BE OPENED FROM OUTSIDE `performClaim` — it does the
 * read and the write itself. So the rival is injected at the moment the INSERT
 * is prepared, which is after the read and before the write. Without the
 * injection this branch is unreachable by any test, which is how it would ship
 * untested.
 */
test('performClaim reports a CONFLICT when the swap loses, not a grant nobody holds', () => {
  const db = freshDb();
  let injected = false;

  const racing = new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare') {
        return (sql: string) => {
          if (!injected && sql.trimStart().startsWith('INSERT INTO claims')) {
            injected = true;
            // Raw VALUES, so the rival is not itself subject to the guard.
            target
              .prepare('INSERT INTO claims (resource, holder, note, claimed_at, expires_at) VALUES (?, ?, ?, ?, ?)')
              .run(R, 'claude1', null, NOW, NOW + 10_000);
          }

          return target.prepare(sql);
        };
      }

      const value = Reflect.get(target, prop, target);

      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as unknown as Db;

  const reply = performClaim({
    db: racing,
    holder: 'claude2',
    resource: R,
    note: null,
    now: NOW,
    ttlMinutes: TTL,
  });

  assert.equal(injected, true, 'the rival never landed, so this proves nothing');
  assert.equal(reply.outcome, 'conflict', 'a lost race was reported as a grant');
  assert.equal(reply.held_by, 'claude1');
  assert.equal(reply.lost_race, true);
  assert.deepEqual(holders(db, NOW), ['claude1']);
});

/**
 * ⚠️ THE CONTROL FOR THE DUPLICATE TEST ABOVE, AND IT IS THE INTERESTING HALF.
 *
 * A handover leaves a released row and a live one, and `released_at IS NULL`
 * already excludes the old one. So `MAX(id)` was never what kept a handover
 * showing one holder — the claim in its old comment was false, and its only
 * real effect was hiding the duplicate above.
 */
test('a HANDOVER still reports one holder, with no MAX(id) involved', () => {
  const db = freshDb();
  const held = dao.insertClaim(db, {
    resource: R,
    holder: 'claude1',
    note: null,
    claimed_at: NOW,
    expires_at: NOW + 10_000,
  });
  dao.releaseClaim(db, held?.id as number, NOW + 10);
  dao.insertClaim(db, {
    resource: R,
    holder: 'claude2',
    note: null,
    claimed_at: NOW + 20,
    expires_at: NOW + 10_000,
  });

  assert.deepEqual(holders(db, NOW + 30), ['claude2']);
});
