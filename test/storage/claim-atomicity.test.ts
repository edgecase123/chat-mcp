import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate } from '../../src/storage/db.js';
import * as dao from '../../src/storage/dao.js';

/**
 * 🛑 THE GUARD WAS NOT ATOMIC, SO THE BUG SURVIVED IT UNDER A RACE.
 *
 * `refuseLiveRival` READ the incumbent and `INSERT .. ON CONFLICT` WROTE it,
 * with nothing holding the row in between. Two processes launching together
 * both read "this handle is free", both passed the guard, and both wrote —
 * each believing it owned the handle. Found by claude1 reviewing this branch.
 *
 * The fix is a compare-and-swap: the write insists the pid is still the one
 * the guard judged.
 */

function tempDb(): { db: DatabaseSync; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'chat-mcp-atomicity-'));
  const db = new DatabaseSync(join(dir, 'chat.db'));
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 0');
  migrate(db);

  return {
    db,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * 🚨 THE EVIDENCE AGAINST THE OBVIOUS FIX, AND IT IS THE INTERESTING HALF.
 *
 * Wrapping the read and the write in the existing `tx()` helper looks like the
 * answer. It is not: `tx()` issues a plain `BEGIN`, which is DEFERRED and
 * takes no write lock, so two connections both get inside and both still read
 * "this handle is free". Measured here rather than asserted, because the whole
 * design choice rests on it.
 */
test('plain BEGIN does NOT serialise two claimants — both get inside and both read the same thing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chat-mcp-deferred-'));
  const path = join(dir, 'chat.db');

  try {
    const a = new DatabaseSync(path);
    a.exec('PRAGMA journal_mode = WAL');
    migrate(a);

    const b = new DatabaseSync(path);
    b.exec('PRAGMA busy_timeout = 0');

    a.exec('BEGIN');
    b.exec('BEGIN');

    const seenByA = a.prepare('SELECT COUNT(*) AS n FROM agents').get() as { n: number };
    const seenByB = b.prepare('SELECT COUNT(*) AS n FROM agents').get() as { n: number };

    assert.equal(
      seenByA.n,
      seenByB.n,
      'the readers disagree, which would mean a plain BEGIN had serialised them',
    );

    a.exec('ROLLBACK');
    b.exec('ROLLBACK');
    a.close();
    b.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * 🛑 THE RACE, TESTED AT THE UNIT THAT GUARDS IT.
 *
 * ⚠️ AN EARLIER VERSION OF THIS TEST WAS VACUOUS AND THE NEGATIVE CONTROL IS
 * WHAT CAUGHT IT. It let a rival claim the handle and then asserted the next
 * `upsertAgent` threw — but that throw came from the LIVENESS guard, which
 * re-reads and sees a live rival. With the compare-and-swap deleted the test
 * still passed, 15 of 15. The window between the read and the write cannot be
 * opened from outside `upsertAgent`, so the swap is tested as its own unit.
 */
test('writeClaim REFUSES when the expected pid is not what is in the row', () => {
  const { db, cleanup } = tempDb();

  try {
    dao.upsertAgent(db, { handle: 'claude2', pid: process.pid, session_id: 'rival' });

    // What a claimant that read "handle is free" would write.
    const won = dao.writeClaim(
      db,
      { handle: 'claude2', pid: process.pid + 1, session_id: 'loser' },
      null,
    );

    assert.equal(won, false, 'a stale claim was written anyway');
    assert.equal(dao.getAgent(db, 'claude2')?.session_id, 'rival', 'the rival was overwritten');
  } finally {
    cleanup();
  }
});

test('writeClaim SUCCEEDS when the expected pid still matches the row', () => {
  const { db, cleanup } = tempDb();

  try {
    dao.upsertAgent(db, { handle: 'claude2', pid: 4194303, session_id: 'crashed' });

    const won = dao.writeClaim(
      db,
      { handle: 'claude2', pid: process.pid, session_id: 'fresh' },
      4194303,
    );

    assert.equal(won, true, 'a valid claim was refused');
    assert.equal(dao.getAgent(db, 'claude2')?.session_id, 'fresh');
  } finally {
    cleanup();
  }
});

test('writeClaim on a FREE handle expects NULL and succeeds', () => {
  const { db, cleanup } = tempDb();

  try {
    const won = dao.writeClaim(db, { handle: 'claude2', pid: process.pid, session_id: 's1' }, null);

    assert.equal(won, true);
    assert.equal(dao.getAgent(db, 'claude2')?.session_id, 's1');
  } finally {
    cleanup();
  }
});

/**
 * 🛑 THE CONFLICT MUST REACH THE CALLER AS THE NAMED ERROR. A `false` that
 * nobody checks is the original bug with extra steps.
 */
test('upsertAgent turns a lost swap into HandleClaimedError', () => {
  const { db, cleanup } = tempDb();

  try {
    dao.upsertAgent(db, { handle: 'claude2', pid: process.pid, session_id: 'rival' });

    assert.throws(
      () => dao.upsertAgent(db, { handle: 'claude2', pid: process.pid + 1, session_id: 'loser' }),
      dao.HandleClaimedError,
    );
  } finally {
    cleanup();
  }
});

/**
 * ⚠️ The compare-and-swap must not break the case that happens on every boot.
 * A shim re-registering its own handle has an expected pid equal to its own,
 * so the swap has to match.
 */
test('the same process re-registering still succeeds through the compare-and-swap', () => {
  const { db, cleanup } = tempDb();

  try {
    dao.upsertAgent(db, { handle: 'claude2', pid: process.pid, session_id: 's1' });
    const again = dao.upsertAgent(db, { handle: 'claude2', pid: process.pid, session_id: 's2' });

    assert.equal(again.session_id, 's2');
  } finally {
    cleanup();
  }
});

/**
 * 🛑 A FORCED CLAIM MUST NOT LOSE THE RACE TO THE ROW IT IS OVERRIDING.
 * `force` means "take it regardless", so it writes unconditionally.
 */
test('force writes unconditionally, so it cannot be refused by its own target', () => {
  const { db, cleanup } = tempDb();

  try {
    dao.upsertAgent(db, { handle: 'claude2', pid: process.pid, session_id: 'incumbent' });

    const stolen = dao.upsertAgent(db, {
      handle: 'claude2',
      pid: process.pid + 1,
      session_id: 'forced',
      force: true,
    });

    assert.equal(stolen.session_id, 'forced');
  } finally {
    cleanup();
  }
});

/**
 * A dead incumbent is debris, and taking it over goes through the same swap.
 * The expected pid is the dead one, which is still what is in the row.
 */
test('taking over a DEAD incumbent still passes the compare-and-swap', () => {
  const { db, cleanup } = tempDb();

  try {
    dao.upsertAgent(db, { handle: 'claude2', pid: 4194303, session_id: 'crashed' });

    const taken = dao.upsertAgent(db, {
      handle: 'claude2',
      pid: process.pid,
      session_id: 'fresh',
    });

    assert.equal(taken.session_id, 'fresh');
  } finally {
    cleanup();
  }
});

/** The connection must still be usable after a refusal — nothing left open. */
test('a refusal leaves the connection usable', () => {
  const { db, cleanup } = tempDb();

  try {
    dao.upsertAgent(db, { handle: 'claude2', pid: process.pid, session_id: 's1' });

    assert.throws(() =>
      dao.upsertAgent(db, { handle: 'claude2', pid: process.pid + 1, session_id: 's2' }),
    );

    dao.upsertAgent(db, { handle: 'other', pid: process.pid, session_id: 's3' });
    assert.equal(dao.getAgent(db, 'other')?.session_id, 's3');
  } finally {
    cleanup();
  }
});
