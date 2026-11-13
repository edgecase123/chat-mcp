import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 🛑 BEFORE any import that resolves a state path — notifyPeer writes there.
process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), 'chat-mcp-gaugereport-'));

const { migrate } = await import('../../src/storage/db.js');
const dao = await import('../../src/storage/dao.js');
const { applyContextReport } = await import('../../src/shim/gauge-report.js');
const { deadPid } = await import('../support/dead-pid.js');

/**
 * 🛑 THE WRITE, THE HYSTERESIS AND THE FANOUT WERE COPIED IN TWO FILES, and
 * #213 wants the supervisor to be a third. `gauge.ts` already de-duplicated
 * the band LITERALS; everything around them stayed duplicated.
 */

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  dao.upsertAgent(db, { handle: 'claude9', pid: deadPid(), session_id: 'claude9' });

  return db;
}

test('the reading lands on the agent row', () => {
  const db = freshDb();

  applyContextReport(db, 'claude9', 120_000, 1_000_000);

  const me = dao.getAgent(db, 'claude9');
  assert.equal(me?.context_used, 120_000);
  assert.equal(me?.context_total, 1_000_000);
});

test('the payload carries the percent to one decimal', () => {
  const db = freshDb();

  const out = applyContextReport(db, 'claude9', 118_783, 1_000_000);

  assert.equal(out.percent, 11.9);
  assert.equal(out.fired, null, 'nothing is crossed at 11.9%');
});

test('crossing the planning band DMs the agent and records the band', () => {
  const db = freshDb();

  const out = applyContextReport(db, 'claude9', 510_000, 1_000_000);

  assert.equal(out.fired, 50);
  assert.equal(out.notified.dm, 1);
  assert.deepEqual(out.notified.rooms, [], 'a plan is not an escalation, so no room post');
  assert.equal(dao.getAgent(db, 'claude9')?.context_warned_threshold, 50);
});

test('crossing the room band posts to every room the agent is in', () => {
  const db = freshDb();
  dao.upsertAgent(db, { handle: 'claude8', pid: deadPid(), session_id: 'claude8' });
  dao.joinRoom(db, '#gate', 'claude9');
  dao.joinRoom(db, '#gate', 'claude8');

  const out = applyContextReport(db, 'claude9', 860_000, 1_000_000);

  assert.equal(out.fired, 85);
  assert.deepEqual(out.notified.rooms, ['#gate']);
  assert.equal(out.notified.dm, 0);
});

/**
 * ⚠️ THE SECOND REPORT IS THE ONE THAT CHATTERS. A gauge sitting just over a
 * band re-reports on every turn, and without the stored threshold each one
 * would fire again.
 */
test('sitting inside a band already warned fires nothing the second time', () => {
  const db = freshDb();

  assert.equal(applyContextReport(db, 'claude9', 510_000, 1_000_000).fired, 50);
  const second = applyContextReport(db, 'claude9', 520_000, 1_000_000);

  assert.equal(second.fired, null);
  assert.equal(second.notified.dm, 0);
});

/**
 * 🛑 AN UNREGISTERED HANDLE IS THE CALLER'S POLICY, NOT THIS FUNCTION'S. The
 * hook must never throw inside a PreToolUse, the MCP tool wants to say so.
 * Both decide before calling; this one just must not crash.
 */
test('an unknown handle does not throw here', () => {
  const db = freshDb();

  assert.doesNotThrow(() => applyContextReport(db, 'nobody', 1, 10));
});
