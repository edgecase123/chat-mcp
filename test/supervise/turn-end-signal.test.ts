import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../../src/storage/db.js';
import type { AgentChild, SpawnOptions } from '../../src/supervise/child.js';
import { startSupervisor } from '../../src/supervise/index.js';

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
    send: () => undefined,
    onTurnEnd: (cb) => {
      endTurn = cb;
    },
    onUsage: () => undefined,
    onDenial: () => undefined,
    onSession: (cb) => cb('sess'),
    onEvent: () => undefined,
    onExit: () => undefined,
    kill: () => undefined,
  });

  const sup = await startSupervisor({
    handle: `turn-${process.pid}`,
    db,
    extraDirs: [process.cwd()],
    spawnChild,
    log: () => undefined,
  });

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
