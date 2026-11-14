import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), 'chat-mcp-2nd-sup-'));

const { startSupervisor } = await import('../../src/supervise/index.js');
import type { AgentChild } from '../../src/supervise/child.js';
import { supervisorOptions } from '../support/supervisor-options.js';

const DIRS = [process.cwd()];

/** The whole seam, so an incomplete fake cannot pass for a child. */
function fakeChild(): AgentChild {
  return {
    reportsUsage: true,
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
 * 🛑 THE ASSERTION IS THE ORDER, NOT THE REFUSAL. A rejection alone passes
 * even when the spawn already ran and took the first agent's container down
 * with `docker rm -f` — which is the whole of #154. `spawns` proves the
 * refusal came FIRST.
 */
test('a second supervisor for a live handle refuses BEFORE it spawns anything', async () => {
  let spawns = 0;
  const spawnChild = (): AgentChild => {
    spawns += 1;

    return fakeChild();
  };

  const first = await startSupervisor(supervisorOptions({
    extraDirs: DIRS,
    handle: 'twice',
    spawnChild,
    log: () => undefined,
  }));

  assert.equal(spawns, 1, 'the first supervisor must spawn');

  try {
    await assert.rejects(
      () =>
        startSupervisor(supervisorOptions({
          extraDirs: DIRS,
          handle: 'twice',
          spawnChild,
          log: () => undefined,
        })),
      /already listening/,
    );

    assert.equal(spawns, 1, 'the second supervisor must not have spawned a child');
  } finally {
    await first.stop();
  }
});

/** The negative control: a free handle still spawns, so the guard is not a blanket refusal. */
test('a free handle still spawns', async () => {
  let spawns = 0;
  const sup = await startSupervisor(supervisorOptions({
    extraDirs: DIRS,
    handle: 'only-one',
    spawnChild: (): AgentChild => {
      spawns += 1;

      return fakeChild();
    },
    log: () => undefined,
  }));

  try {
    assert.equal(spawns, 1);
  } finally {
    await sup.stop();
  }
});
