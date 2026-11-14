import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), 'chat-mcp-exitpid-'));

const { startSupervisor } = await import('../../src/supervise/index.js');
const { migrate } = await import('../../src/storage/db.js');
const dao = await import('../../src/storage/dao.js');
import type { AgentChild, SpawnOptions } from '../../src/supervise/child.js';
import { supervisorOptions } from '../support/supervisor-options.js';

/**
 * 🛑 AN EXITED DOCKERIZED CHILD READ `online: true` UNTIL ITS SUPERVISOR DIED.
 *
 * `online` is `isProcessAlive(row.pid)`, and a containerized child's row is
 * written by `shimContextFor` inside the host bus — so the pid is the
 * SUPERVISOR's. A sibling then handed a review to a handle with nothing behind
 * it, and `room_send` reported it delivered.
 *
 * 🛑 THE HANDLE IS THE WHOLE RISK HERE. Nulling `opts.handle`'s row instead of
 * the CHILD's would take the live supervisor offline on the bus, which is a
 * worse fault than the one being fixed. The control below is what pins it.
 */

const DIRS = [process.cwd()];

/** Every member, so a partial fake never fails a test for the wrong reason. */
function fakeChild(capture: { fire?: (code: number | null, signal: string | null) => void }): AgentChild {
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
    onExit: (cb) => {
      capture.fire = cb;
    },
    kill: () => undefined,
  };
}

/** A LIVE pid, so `online` is true until something clears it. */
function dbWith(handles: readonly string[]): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  for (const handle of handles) {
    dao.upsertAgent(db, { handle, pid: process.pid, session_id: `s-${handle}`, display_name: handle, metadata: {} });
    assert.equal(dao.getAgent(db, handle)?.online, true, `fixture ${handle} must start online`);
  }

  return db;
}

async function start(handle: string, db: DatabaseSync) {
  const capture: { fire?: (code: number | null, signal: string | null) => void } = {};
  const s = await startSupervisor(supervisorOptions({
    extraDirs: DIRS,
    handle,
    db,
    spawnChild: (_o: SpawnOptions) => fakeChild(capture),
    log: () => undefined,
  }));

  assert.ok(capture.fire, 'the supervisor must register an onExit handler');

  return { s, fire: capture.fire };
}

test('🚨 a child exit takes the CHILD handle offline on the bus', async () => {
  const db = dbWith(['sup-1', 'sup-1-agent']);
  const { s, fire } = await start('sup-1', db);

  fire(243, null);

  assert.equal(dao.getAgent(db, 'sup-1-agent')?.online, false);
  assert.equal(dao.getAgent(db, 'sup-1-agent')?.pid, null);
  await s.stop();
  db.close();
});

/**
 * 🛑 THE CONTROL THAT MATTERS. Clearing `opts.handle` would pass the test above
 * only if the two handles were confused, and it would take a LIVE supervisor
 * offline.
 */
test('🚨 the SUPERVISOR\'s own row is untouched by its child exiting', async () => {
  const db = dbWith(['sup-2', 'sup-2-agent']);
  const { s, fire } = await start('sup-2', db);

  fire(243, null);

  assert.equal(dao.getAgent(db, 'sup-2')?.online, true, 'the supervisor is still running');
  assert.equal(dao.getAgent(db, 'sup-2')?.pid, process.pid);
  await s.stop();
  db.close();
});

/** The negative control: nothing clears the row before the child exits. */
test('🚨 the child handle stays online while the child is alive', async () => {
  const db = dbWith(['sup-3', 'sup-3-agent']);
  const { s } = await start('sup-3', db);

  assert.equal(dao.getAgent(db, 'sup-3-agent')?.online, true);
  await s.stop();
  db.close();
});

/**
 * ⚠️ THE ROW IS WRITTEN BY THE CHILD'S SHIM, so a child that dies before
 * registering has no row at all. An UPDATE against a missing row is a silent
 * no-op, which is survivable — a THROW inside `onExit` is not, because the
 * unsent-prompt report below it would never run.
 */
test('🚨 a child that exits before it ever registered does not throw', async () => {
  const db = dbWith(['sup-4']);
  const { s, fire } = await start('sup-4', db);

  assert.equal(dao.getAgent(db, 'sup-4-agent'), null, 'fixture: the child never registered');
  assert.doesNotThrow(() => fire(1, null));

  await s.stop();
  db.close();
});

/** The row must survive as an offline entry, not vanish like a deregister. */
test('🚨 the cleared child handle is still listed, as offline', async () => {
  const db = dbWith(['sup-5', 'sup-5-agent']);
  const { s, fire } = await start('sup-5', db);

  fire(243, null);

  const offline = dao.listAgents(db, true).map((a) => a.handle);
  assert.equal(offline.includes('sup-5-agent'), true, 'the handle must not be deleted');
  assert.equal(dao.listAgents(db).map((a) => a.handle).includes('sup-5-agent'), false);
  await s.stop();
  db.close();
});
