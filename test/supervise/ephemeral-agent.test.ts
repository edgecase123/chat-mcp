import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), 'chat-mcp-eph-'));

const { startSupervisor } = await import('../../src/supervise/index.js');
const { migrate } = await import('../../src/storage/db.js');
const dao = await import('../../src/storage/dao.js');
import type { AgentChild, SpawnOptions } from '../../src/supervise/child.js';
import { supervisorOptions } from '../support/supervisor-options.js';

/**
 * 🛑 EVERY LIVE HARNESS RUN LEFT A THROWAWAY AGENT ON THE BUS FOREVER.
 *
 * They sat in `list_agents` and in `whoami`'s peer list beside real peers, and
 * a stale handle is indistinguishable from a live one at the moment you send to
 * it. Eleven had to be deleted by hand.
 */

const DIRS = [process.cwd()];

/**
 * ⚠️ EVERY MEMBER, NOT THE ONES THIS FILE USES. A partial fake tests a child
 * that cannot exist, and the first draft here died on `child.onExit is not a
 * function` — six red tests for a reason that was not the one under test.
 */
function fakeChild(): AgentChild {
  return {
    reportsUsage: false,
    reportsContext: true,
    send: () => undefined,
    onTurnEnd: () => undefined,
    onContext: () => undefined,
    onUsage: () => undefined,
    onDenial: () => undefined,
    onSession: () => undefined,
    onEvent: () => undefined,
    onStderr: () => undefined,
    onExit: () => undefined,
    kill: () => undefined,
  };
}

/**
 * ⚠️ `includeOffline`, because `listAgents` defaults to ONLINE ONLY and derives
 * `online` from the pid. Measured: the mutant with it dropped still failed 4 of
 * 6, because this fixture's pid 1 is live — so it is defence against a future
 * fixture with a dead pid, not a fix for blindness here. The real catch was the
 * reclaim asserting a pid 2 that does not exist, which reported 0 rows.
 */
function dbWithAgent(handle: string): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  dao.upsertAgent(db, {
    handle,
    pid: 1,
    session_id: 's',
    display_name: handle,
    metadata: {},
  });
  dao.joinRoom(db, '#r', handle);
  assert.equal(dao.listAgents(db, true).some((a) => a.handle === handle), true, 'fixture registered');
  return db;
}

function start(handle: string, db: DatabaseSync, ephemeral?: boolean) {
  return startSupervisor(supervisorOptions({
    extraDirs: DIRS,
    handle,
    db,
    ephemeral,
    spawnChild: (_o: SpawnOptions) => fakeChild(),
    log: () => undefined,
  }));
}

test('🚨 an ephemeral supervisor deregisters its agent on stop', async () => {
  const db = dbWithAgent('eph-1');
  const s = await start('eph-1', db, true);

  await s.stop();

  assert.equal(dao.listAgents(db, true).some((a) => a.handle === 'eph-1'), false);
  db.close();
});

/**
 * 🛑 THE NEGATIVE CONTROL. A `stop()` that always deregistered would pass the
 * test above, and it would delete the row of a real `chat-mcp supervise`
 * session — which the handle-claim path is built on.
 */
test('🚨 a NON-ephemeral supervisor leaves its agent registered', async () => {
  const db = dbWithAgent('keep-1');
  const s = await start('keep-1', db);

  await s.stop();

  assert.equal(dao.listAgents(db, true).some((a) => a.handle === 'keep-1'), true);
  db.close();
});

/**
 * ⚠️ `ephemeral: false` MUST BEHAVE LIKE ABSENT. A truthiness bug here is
 * invisible, because the default and the explicit opt-out look the same.
 */
test('🚨 ephemeral: false is an opt-OUT, not a missing flag', async () => {
  const db = dbWithAgent('keep-2');
  const s = await start('keep-2', db, false);

  await s.stop();

  assert.equal(dao.listAgents(db, true).some((a) => a.handle === 'keep-2'), true);
  db.close();
});

/**
 * 🛑 THE HANDLE-CLAIM PATH IS BUILT ON THE ROW'S PRESENCE, and nothing covered
 * register, deregister, then register again for ONE handle.
 */
test('🚨 a handle freed by an ephemeral stop can be claimed again', async () => {
  const db = dbWithAgent('reclaim');
  const s = await start('reclaim', db, true);
  await s.stop();

  // A LIVE pid, so the reclaim is the real thing the handle-claim path guards.
  dao.upsertAgent(db, {
    handle: 'reclaim',
    pid: process.pid,
    session_id: 's2',
    display_name: 'reclaim',
    metadata: {},
  });

  const rows = dao.listAgents(db, true).filter((a) => a.handle === 'reclaim');
  assert.equal(rows.length, 1, 'one row, not a duplicate');
  assert.equal(rows[0]?.pid, process.pid, 'the new session owns it');
  assert.equal(rows[0]?.online, true, 'and it is live, not a revived corpse');
  db.close();
});

/**
 * ⚠️ A REJOINED HANDLE MUST NOT INHERIT THE OLD RUN'S ROOM STATE. `deleteAgent`
 * clears `room_members` and `room_reads`, so assert that the ephemeral path
 * really goes through it rather than deleting the `agents` row alone.
 */
test('🚨 an ephemeral stop clears room membership too, not just the agent row', async () => {
  const db = dbWithAgent('eph-2');
  assert.equal(dao.isRoomMember(db, '#r', 'eph-2'), true, 'fixture joined');
  const s = await start('eph-2', db, true);

  await s.stop();

  assert.equal(dao.isRoomMember(db, '#r', 'eph-2'), false);
  db.close();
});

/** Stopping twice must not throw — `stop()` is called in a `finally`. */
test('🚨 a second stop is a no-op, not a throw', async () => {
  const db = dbWithAgent('eph-3');
  const s = await start('eph-3', db, true);

  await s.stop();
  await s.stop();

  assert.equal(dao.listAgents(db, true).some((a) => a.handle === 'eph-3'), false);
  db.close();
});
