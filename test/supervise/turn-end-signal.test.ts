import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 🛑 BEFORE any import that resolves a state path. See replace-child.test.ts.
process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), 'chat-mcp-turnend-'));

const { migrate } = await import('../../src/storage/db.js');
const { startSupervisor } = await import('../../src/supervise/index.js');
import type { AgentChild, SpawnOptions } from '../../src/supervise/child.js';
import { supervisorOptions } from '../support/supervisor-options.js';

/**
 * 🛑 THE SUPERVISOR KNOWS WHEN A TURN ENDS AND WOULD NOT TELL ANYONE.
 *
 * It logged `← turn complete` and kept the signal to itself, so a harness
 * waiting for the agent to stop had to guess with a timer. Two capture
 * scripts used a quiet-period heuristic, and claude1 named it on PR 43: a
 * timing guess standing in for a signal that already existed. 12 seconds of
 * quiet is shorter than a routine model pause.
 */
test('a caller can observe the turn ending, instead of timing it', async () => {
  const db = new DatabaseSync(':memory:');
  migrate(db);

  let endTurn: (() => void) | undefined;

  const spawnChild = (_opts: SpawnOptions): AgentChild => ({
    reportsUsage: false,
    reportsContext: true,
    send: () => undefined,
    onTurnEnd: (cb) => {
      endTurn = cb;
    },
    onContext: () => undefined,
    onUsage: () => undefined,
    onDenial: () => undefined,
    onSession: (cb) => cb('sess'),
    onEvent: () => undefined,
    onStderr: () => undefined,
    onExit: () => undefined,
    kill: () => undefined,
  });

  const sup = await startSupervisor(supervisorOptions({
    handle: `turn-${process.pid}`,
    db,
    extraDirs: [process.cwd()],
    spawnChild,
    log: () => undefined,
  }));

  try {
    let turns = 0;

    sup.onTurnEnd(() => {
      turns += 1;
    });

    assert.equal(turns, 0, 'a turn ended before the child did anything');

    endTurn?.();
    endTurn?.();

    assert.equal(turns, 2, 'the caller was not told the turn ended');
  } finally {
    await sup.stop();
  }
});
