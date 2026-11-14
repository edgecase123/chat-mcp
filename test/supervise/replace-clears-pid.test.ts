import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 🛑 BEFORE any import that resolves a state path.
process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), 'chat-mcp-replpid-'));

const { migrate } = await import('../../src/storage/db.js');
const { startSupervisor } = await import('../../src/supervise/index.js');
const { deliverToSupervisor } = await import('../../src/supervise/socket.js');
const { claudeSpawn } = await import('../../src/adapters/claude-spawn.js');
const dao = await import('../../src/storage/dao.js');
import type { AgentChild, SpawnOptions } from '../../src/supervise/child.js';

/**
 * 🛑 A REPLACED CHILD'S EXIT IS DROPPED, SO `onExit` CANNOT BE THE ONLY PLACE
 * THE BUS LEARNS A CHILD IS GONE.
 *
 * `kill()` is best-effort and returns immediately — `child.ts` says so,
 * because a containerized child spawns `docker stop` detached. The exit
 * therefore lands AFTER `wireChild()` has run `++childGeneration`, and
 * `ifCurrent` drops it as stale. So an approval grant or a model switch left
 * `online` true for a child that no longer existed, and forever if the
 * respawn failed.
 *
 * 🛑 THE FIX IS NOT TO MOVE THE CLEAR OUTSIDE `ifCurrent`. That would clear a
 * LIVE child's pid every time a stale signal arrived. Raised by claude2 on
 * PR 235.
 *
 * ⚠️ THIS FILE'S FAKE NEVER FIRES `onExit` FROM `kill()`, AND THAT IS THE WHOLE
 * POINT. `replace-child.test.ts` fires it synchronously there, which lands
 * BEFORE the generation bump — so that fixture cannot see this bug at all. A
 * test written against the synchronous fake passes with no fix.
 */

const DIRS = [process.cwd()];

interface Spawned {
  readonly opts: SpawnOptions;
  /**
   * 🛑 THE TEST FIRES THE EXIT, NOT A TIMER. A `setImmediate` from `kill()`
   * lands at a moment the test cannot name, and a control that re-registers
   * the replacement AFTER that moment never exercises a stale exit against a
   * live child. Measured: with the timer, the mutant that clears outside
   * `ifCurrent` passed every assertion and only crashed on a closed database.
   */
  fireExit: () => void;
  killed: () => boolean;
}

/** Every member, so a partial fake never fails a test for the wrong reason. */
function deferredExitChild(spawned: Spawned[]) {
  return (opts: SpawnOptions): AgentChild => {
    let onExit: ((code: number | null, signal: string | null) => void) | undefined;
    let wasKilled = false;
    spawned.push({
      opts,
      fireExit: () => onExit?.(null, 'SIGTERM'),
      killed: () => wasKilled,
    });

    return {
      reportsUsage: false,
      reportsContext: true,
      send: () => undefined,
      onTurnEnd: () => undefined,
      onContext: () => undefined,
      onUsage: () => undefined,
      onDenial: () => undefined,
      onSession: (cb) => cb('sess-from-fake'),
      onEvent: () => undefined,
      onExit: (cb) => {
        onExit = cb;
      },
      // 🛑 NO EXIT HERE, like the real thing. `kill()` returns immediately
      // because `docker stop` is detached, so the exit is a LATER event the
      // test schedules deliberately.
      kill: () => {
        wasKilled = true;
      },
    };
  };
}

async function supervisorWithDb(handle: string, spawned: Spawned[]) {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  // The CHILD's row, registered with a LIVE pid as its own shim would.
  dao.upsertAgent(db, {
    handle: `${handle}-agent`,
    pid: process.pid,
    session_id: 's',
    display_name: `${handle}-agent`,
    metadata: {},
  });
  assert.equal(dao.getAgent(db, `${handle}-agent`)?.online, true, 'fixture must start online');

  const sup = await startSupervisor({
    handle,
    vendor: claudeSpawn,
    db,
    extraDirs: DIRS,
    spawnChild: deferredExitChild(spawned),
    log: () => undefined,
  });

  return { sup, db };
}

function approve(handle: string) {
  return deliverToSupervisor(handle, {
    id: 10,
    to: handle,
    from: 'lee',
    ts: Date.now(),
    approval: {
      approvalId: 1,
      decision: 'approve' as const,
      requested: "rm in '/tmp/x.txt'",
      grant: 'Bash(rm -f /tmp/x.txt)',
      sessionId: 'sess-1',
    },
  });
}

test('🚨 a replaced child is taken offline even though its exit is dropped as stale', async () => {
  const spawned: Spawned[] = [];
  const handle = `rp-${process.pid}-a`;
  const { sup, db } = await supervisorWithDb(handle, spawned);

  try {
    await approve(handle);

    assert.equal(spawned.length, 2, 'the child was never replaced, so this test measures nothing');
    assert.equal(spawned[0]!.killed(), true, 'the old child was never killed');

    // The old child's exit arrives LATE, after the generation moved.
    spawned[0]!.fireExit();

    assert.equal(dao.getAgent(db, `${handle}-agent`)?.online, false);
    assert.equal(dao.getAgent(db, `${handle}-agent`)?.pid, null);
  } finally {
    await sup.stop();
    db.close();
  }
});

/**
 * 🛑 THE CONTROL. Clearing on every stale signal would also pass the test
 * above, and it would take a LIVE child offline on each one.
 */
test('🚨 a stale signal from the OLD child does not clear the NEW one', async () => {
  const spawned: Spawned[] = [];
  const handle = `rp-${process.pid}-b`;
  const { sup, db } = await supervisorWithDb(handle, spawned);

  try {
    await approve(handle);
    assert.equal(spawned.length, 2, 'the child was never replaced');

    // The replacement re-registers its own pid, as its shim does on boot.
    dao.upsertAgent(db, {
      handle: `${handle}-agent`,
      pid: process.pid,
      session_id: 's2',
      display_name: `${handle}-agent`,
      metadata: {},
      force: true,
    });
    assert.equal(dao.getAgent(db, `${handle}-agent`)?.online, true, 'the replacement is live');

    // 🛑 NOW the dead child's exit lands, AFTER the live replacement owns the
    // row. This is the ordering the mutant gets wrong.
    spawned[0]!.fireExit();

    assert.equal(dao.getAgent(db, `${handle}-agent`)?.online, true, 'a stale exit cleared a LIVE child');
    assert.equal(dao.getAgent(db, `${handle}-agent`)?.pid, process.pid);
  } finally {
    await sup.stop();
    db.close();
  }
});

/** The row must survive the replace, not be deleted out from under the new child. */
test('🚨 a replace leaves the handle listed, so it can re-register', async () => {
  const spawned: Spawned[] = [];
  const handle = `rp-${process.pid}-c`;
  const { sup, db } = await supervisorWithDb(handle, spawned);

  try {
    await approve(handle);
    spawned[0]!.fireExit();

    const listed = dao.listAgents(db, true).map((a) => a.handle);
    assert.equal(listed.includes(`${handle}-agent`), true, 'the replace must not delete the row');
  } finally {
    await sup.stop();
    db.close();
  }
});
