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
 * Every `await` in `window` that is NOT inside a nested function body.
 *
 * 🛑 A BLOCK IS NOT A FUNCTION. An `await` inside an `if`, `try` or `for` at
 * this level still yields, so it counts; one inside `const doStop = async
 * (...) => {` does not, because that body runs later.
 *
 * ⚠️ IT DOES NOT READ INDENTATION, and the first version did. `/^ {2}\S/`
 * tests the line the `await` sits on, so `helper(\n  await x(),\n)` and
 * `if (c) {\n  await x();\n}` both hid a real yield from it — 1 of 3 detected
 * on a synthetic window. Found by claude1 reviewing this PR.
 */
function topLevelYields(window: string[]): string[] {
  const hits: string[] = [];
  /** Per open brace: was it a function body? */
  const scopes: boolean[] = [];

  for (const raw of window) {
    const trimmed = raw.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;

    const code = raw.replace(/\/\/.*$/, '');

    if (!scopes.includes(true) && /\bawait\b/.test(code)) hits.push(trimmed);

    for (const ch of code) {
      if (ch === '{') scopes.push(/=>|\bfunction\b/.test(code));
      else if (ch === '}') scopes.pop();
    }
  }

  return hits;
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
  // The wrapper closure is part of the bind statement, so the window starts
  // after it closes.
  const wrapperEnd = lines.findIndex((l, i) => i > bindAt && l === '  });');
  const installAt = lines.findIndex((l) => /^\s*onWake = /.test(l));
  assert.ok(wrapperEnd > bindAt, "the bind's wrapper must close");
  assert.ok(installAt > wrapperEnd, 'the handler install must follow the bind');

  // 🛑 EXACTLY ONE, AND IT IS WHY THE REFUSAL IS LIVE CODE RATHER THAN DEAD.
  // The spawn-failure path awaits `listener.close()`, so the socket is open
  // across a yield while no handler is installed. That path throws and never
  // reaches the install, so it cannot make the SUCCESS path reachable — but a
  // wake arriving during that teardown is answered by the refusal.
  //
  // Pinned rather than asserted empty: a NEW yield here fails this test, which
  // is the alarm. Found by the detector itself, not by reading the diff.
  assert.deepEqual(
    topLevelYields(lines.slice(wrapperEnd + 1, installAt)),
    ['await listener.close();'],
    'a NEW top-level await here puts the success path in the gap; add it only with the refusal in mind',
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

/**
 * 🛑 THE POSITION IS THE PROPERTY, AND A COMMENT CANNOT HOLD IT.
 *
 * The wrapper's refusal has to be its FIRST statement. Below the stop branch
 * it is already too late: a stop wake reaches `doStop` inside a
 * `setImmediate`, where a dead-zone throw lands outside this call stack and
 * takes the supervisor down instead of refusing.
 *
 * The source comment above that line says exactly this, and nothing enforced
 * it until here. A later edit inserting a branch above the refusal would read
 * as harmless.
 */
test('🛑 the refusal is the wrapper FIRST statement, above the stop branch', () => {
  const src = readFileSync(new URL('../../src/supervise/index.ts', import.meta.url), 'utf8');
  const lines = src.split('\n');

  const bindAt = lines.findIndex((l) => l.includes('WakeListener.bind('));
  assert.ok(bindAt >= 0, 'bind call not found');

  const wrapperEnd = lines.findIndex((l, i) => i > bindAt && l === '  });');
  const body = lines.slice(bindAt + 1, wrapperEnd);

  const statements = body
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('//') && !l.startsWith('*') && !l.startsWith('/*'));

  assert.ok(statements.length > 0, 'the wrapper body must hold statements');
  assert.match(
    statements[0],
    /^if \(onWake === null\) return \{ ok: false,/,
    'the refusal must come before anything else in the wrapper, including the stop branch',
  );
});
