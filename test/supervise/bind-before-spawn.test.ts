import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), 'chat-mcp-bind-first-'));

const { startSupervisor } = await import('../../src/supervise/index.js');
const { socketPathFor } = await import('../../src/util/paths.js');
import type { AgentChild } from '../../src/supervise/drivers/claude.js';

const DIRS = [process.cwd()];

/** The whole seam, so an incomplete fake cannot pass for a child. */
function fakeChild(): AgentChild {
  return {
    reportsUsage: true,
    send: () => undefined,
    onTurnEnd: () => undefined,
    onUsage: () => undefined,
    onDenial: () => undefined,
    onSession: () => undefined,
    onEvent: () => undefined,
    onExit: () => undefined,
    kill: () => undefined,
  };
}

/**
 * 🛑 THE BIND IS THE ONLY STEP THAT CANNOT BE WON TWICE, so it has to happen
 * before the spawn rather than 500 lines after it. `refuseIfSupervisorLive` is
 * `existsSync` plus a liveness probe, so two supervisors can both read "not
 * live" and both go on to spawn — and a containerized spawn runs
 * `docker rm -f` on a name derived from the handle, which SIGKILLs the first
 * one's live agent.
 *
 * The assertion is the ORDER. A refusal on its own already passed before this
 * change, because the loser refused only after its spawn had run.
 */
test('the wake socket is listening BEFORE the child is spawned', async () => {
  let listeningAtSpawn: boolean | null = null;

  const sup = await startSupervisor({
    extraDirs: DIRS,
    handle: 'bind-first',
    spawnChild: (): AgentChild => {
      listeningAtSpawn = existsSync(socketPathFor('bind-first'));

      return fakeChild();
    },
    log: () => undefined,
  });

  try {
    assert.equal(
      listeningAtSpawn,
      true,
      'the handle must be claimed by the bind before a spawn can run `docker rm -f` on it',
    );
  } finally {
    await sup.stop();
  }
});

/**
 * 🛑 THIS TEST IS WHAT MAKES THE PRE-SPAWN REFUSAL HONEST, and it is the only
 * thing that does.
 *
 * Binding above the spawn opens a window where the socket accepts a wake but
 * no handler is installed yet. That window is UNREACHABLE today, because
 * nothing in it yields: `spawnFn` is a plain function, so Node cannot dispatch
 * an incoming connection until the handler is in place. Measured with a unix
 * socket and an external connector, not reasoned.
 *
 * One `await` in that window turns the refusal from dead defence into the only
 * thing standing between a wake and eight bindings in their temporal dead
 * zone — the first of which is `doStop`, touched inside a `setImmediate`,
 * where the throw lands outside the handler's call stack and takes the
 * supervisor down instead of refusing.
 */
test('🛑 nothing yields between the bind and the handler install', () => {
  const src = readFileSync(new URL('../../src/supervise/index.ts', import.meta.url), 'utf8');
  const lines = src.split('\n');

  const binds = lines.filter((l) => l.includes('WakeListener.bind('));
  assert.equal(binds.length, 1, 'the window is defined by ONE bind; find them all before trusting this');

  const bindAt = lines.findIndex((l) => l.includes('WakeListener.bind('));
  const installAt = lines.findIndex((l) => /^\s*onWake = /.test(l));
  assert.ok(installAt > bindAt, 'the handler install must follow the bind');

  // Statements at the function's own indent level. The wrapper's body is
  // deeper, so an `await` inside a closure is correctly not a yield here.
  const yields = lines
    .slice(bindAt + 1, installAt)
    .map((text, i) => ({ line: bindAt + 2 + i, text: text.trim() }))
    .filter(({ text }, i) => /\bawait\b/.test(text) && /^ {2}\S/.test(lines[bindAt + 1 + i]));

  assert.deepEqual(
    yields,
    [],
    `a top-level await here makes the pre-spawn gap reachable, so the refusal stops being dead code: ${JSON.stringify(yields)}`,
  );
});

/**
 * 🛑 THE REGRESSION THIS REORDER CREATES, AND THE REASON THE SPAWN IS GUARDED.
 *
 * Before the move, nothing was bound when the spawn threw, so a failed start
 * left no socket behind. Binding first means a throw now strands a live
 * listener on the handle — and `refuseIfSupervisorLive` would then report the
 * handle as busy forever, turning one failed start into a permanent one.
 */
test('a spawn failure does not strand the socket on the handle', async () => {
  const { refuseIfSupervisorLive } = await import('../../src/supervise/socket.js');

  await assert.rejects(
    () =>
      startSupervisor({
        extraDirs: DIRS,
        handle: 'spawn-throws',
        spawnChild: (): AgentChild => {
          throw new Error('docker is not running');
        },
        log: () => undefined,
      }),
    /docker is not running/,
  );

  assert.equal(
    existsSync(socketPathFor('spawn-throws')),
    false,
    'the listener must be closed when the start it was claiming the handle for failed',
  );

  // The handle has to be startable again, which is the consequence that matters.
  await assert.doesNotReject(() => refuseIfSupervisorLive('spawn-throws'));
});
