import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import * as dao from '../../src/storage/dao.js';
import { HandleClaimedError, isProcessAlive } from '../../src/storage/dao.js';
import { migrate } from '../../src/storage/db.js';

/**
 * 🛑 THE LOSER OF A HANDLE RACE SEES AN EMPTY ARRAY, NOT AN ERROR.
 *
 * `inbox` and `room_inbox` MARK MESSAGES READ. So when two processes hold one
 * handle, whichever reads first consumes the mail and the other gets `[]` —
 * indistinguishable from "nothing arrived". That is the exact ambiguity
 * chat-mcp#33 exists to remove, reachable by accident because `.mcp.json`
 * hardcodes `--handle`.
 *
 * `WakeListener.bind` already got this right: stale debris is rebound, a LIVE
 * rival is refused. Registration had no such guard.
 */

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  migrate(db);

  return db;
}

/** A pid that is certainly not running. 2^22 is above every default pid_max. */
const DEAD_PID = 4194303;

test('a first claim on a free handle succeeds', () => {
  const db = freshDb();

  const agent = dao.upsertAgent(db, {
    handle: 'claude2',
    pid: process.pid,
    session_id: 's1',
  });

  assert.equal(agent.handle, 'claude2');
});

/**
 * The common case, and it must stay silent. A shim re-registers on every boot
 * and an MCP client may re-register mid-session.
 */
test('the SAME process re-claiming its own handle is idempotent, not a conflict', () => {
  const db = freshDb();

  dao.upsertAgent(db, { handle: 'claude2', pid: process.pid, session_id: 's1' });

  const again = dao.upsertAgent(db, {
    handle: 'claude2',
    pid: process.pid,
    session_id: 's2',
  });

  assert.equal(again.session_id, 's2', 'a re-register must still refresh the session');
});

/**
 * 🚨 THE BUG. Before this guard the second claim overwrote pid and session_id
 * and returned happily, and the first process never learned it had lost its
 * mail.
 */
test('a SECOND LIVE process claiming a held handle is REFUSED', () => {
  const db = freshDb();

  dao.upsertAgent(db, { handle: 'claude2', pid: process.pid, session_id: 's1' });

  assert.throws(
    () => dao.upsertAgent(db, { handle: 'claude2', pid: process.pid + 1, session_id: 's2' }),
    HandleClaimedError,
  );
});

/** The refusal has to be actionable, or the operator's next move is a guess. */
test('the refusal names the handle and the pid that holds it', () => {
  const db = freshDb();

  dao.upsertAgent(db, { handle: 'claude2', pid: process.pid, session_id: 's1' });

  try {
    dao.upsertAgent(db, { handle: 'claude2', pid: process.pid + 1, session_id: 's2' });
    assert.fail('the second claim was allowed');
  } catch (err) {
    assert.ok(err instanceof HandleClaimedError);
    assert.match(err.message, /claude2/);
    assert.match(err.message, new RegExp(String(process.pid)));
  }
});

/**
 * 🛑 A REFUSAL THAT ALSO WROTE WOULD BE THE WORST OUTCOME — the rival would be
 * told no and the row would be clobbered anyway.
 */
test('a refused claim leaves the incumbent row untouched', () => {
  const db = freshDb();

  dao.upsertAgent(db, { handle: 'claude2', pid: process.pid, session_id: 's1' });

  assert.throws(() =>
    dao.upsertAgent(db, { handle: 'claude2', pid: process.pid + 1, session_id: 's2' }),
  );

  const held = dao.getAgent(db, 'claude2');
  assert.equal(held?.pid, process.pid, 'the incumbent pid was overwritten anyway');
  assert.equal(held?.session_id, 's1', 'the incumbent session was overwritten anyway');
});

/**
 * A crashed process leaves a row behind. Refusing forever would make a crash
 * unrecoverable without hand-editing SQLite — so debris is taken over, exactly
 * as `WakeListener.bind` rebinds a stale socket file.
 */
test('a DEAD incumbent is debris and the handle is taken over', () => {
  const db = freshDb();

  dao.upsertAgent(db, { handle: 'claude2', pid: DEAD_PID, session_id: 'crashed' });

  const taken = dao.upsertAgent(db, {
    handle: 'claude2',
    pid: process.pid,
    session_id: 'fresh',
  });

  assert.equal(taken.session_id, 'fresh');
  assert.equal(taken.pid, process.pid);
});

/**
 * ⚠️ A row with no pid cannot be tested for liveness. Refusing would lock the
 * handle permanently on missing data, which is a worse failure than the one
 * being fixed.
 */
test('an incumbent with a NULL pid does not lock the handle', () => {
  const db = freshDb();

  db.prepare(
    `INSERT INTO agents (handle, pid, session_id, registered_at, last_seen_at)
     VALUES ('claude2', NULL, 'old', 1, 1)`,
  ).run();

  const taken = dao.upsertAgent(db, { handle: 'claude2', pid: process.pid, session_id: 'new' });
  assert.equal(taken.session_id, 'new');
});

/**
 * The escape hatch. Pid numbers are reused, so a long-dead incumbent can look
 * live and there must be a way through that is not editing the database.
 */
test('force takes a handle from a LIVE incumbent, and only when asked', () => {
  const db = freshDb();

  dao.upsertAgent(db, { handle: 'claude2', pid: process.pid, session_id: 's1' });

  const stolen = dao.upsertAgent(db, {
    handle: 'claude2',
    pid: process.pid + 1,
    session_id: 's2',
    force: true,
  });

  assert.equal(stolen.session_id, 's2');
});

/**
 * 🛑 THE LIVENESS PROBE IS THE WHOLE GUARD, SO IT GETS ITS OWN TEST. A probe
 * that answered "alive" for everything would make every test above pass for
 * the wrong reason, and a probe that answered "dead" for everything would
 * silently restore the bug.
 */
test('the liveness probe distinguishes this process from a dead pid', () => {
  assert.equal(isProcessAlive(process.pid), true, 'this process reads as dead');
  assert.equal(isProcessAlive(DEAD_PID), false, 'an impossible pid reads as alive');
});
