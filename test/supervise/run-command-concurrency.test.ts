import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// A type-only import is erased, so it resolves no state path at load time.
import type { ScriptRunner } from '../../src/supervise/run-script.js';

// 🛑 BEFORE any import that resolves a state path.
process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), 'chat-mcp-cap-'));

const { registerProject } = await import('../../src/supervise/projects.js');
const { ensureManifestDir, manifestPathFor } = await import('../../src/util/paths.js');
const { runCommandFor } = await import('../../src/supervise/run-command-service.js');

/**
 * 🛑 THE CAP IS PER HANDLE, SO EVERY TEST NEEDS ITS OWN HANDLE. The counters
 * are module state, and a shared handle would make one test's in-flight work
 * the next one's queue.
 */
const handleFor = (name: string) => `cap-${name}-${process.pid}`;

function projectFor(handle: string): void {
  const dir = mkdtempSync(join(tmpdir(), 'chat-mcp-cap-project-'));

  mkdirSync(join(dir, 'scripts'), { recursive: true });

  const slow = join(dir, 'scripts', 'slow.sh');
  writeFileSync(slow, '#!/bin/sh\nexit 0\n');
  chmodSync(slow, 0o755);

  registerProject(handle, dir);
  ensureManifestDir();
  writeFileSync(
    manifestPathFor(handle),
    JSON.stringify({ projectDir: dir, commands: [{ name: 'slow', script: 'scripts/slow.sh', params: [] }] }),
  );
}

/**
 * A runner that never finishes on its own. `started` counts how many reached
 * it, which is the only thing that distinguishes "throttled" from "slow".
 */
function heldRunner() {
  const finish: (() => void)[] = [];
  let started = 0;

  const run = ((_f, _a, _o, cb) => {
    started += 1;
    finish.push(() => cb(null, '', ''));
  }) as ScriptRunner;

  return {
    run,
    get started() {
      return started;
    },
    releaseOne: () => finish.shift()?.(),
  };
}

/** Lets every already-queued microtask and timer turn run. */
const settle = () => new Promise((r) => setTimeout(r, 10));

// ---------------------------------------------------------------------------
// The claim lee approved. Without this one the suite passes on a GLOBAL cap.
// ---------------------------------------------------------------------------

test('🚨 TWO DIFFERENT HANDLES DO NOT BLOCK EACH OTHER, which is what per-handle MEANS', async () => {
  const a = handleFor('two-a');
  const b = handleFor('two-b');

  projectFor(a);
  projectFor(b);

  const runner = heldRunner();

  const first = runCommandFor(a, 'slow', {}, { maxConcurrent: 1, run: runner.run });
  const second = runCommandFor(b, 'slow', {}, { maxConcurrent: 1, run: runner.run });

  await settle();

  assert.equal(runner.started, 2, 'one handle held the other handle out of its own slot');

  runner.releaseOne();
  runner.releaseOne();
  await Promise.all([first, second]);
});

test("🛑 A SECOND COMMAND FOR THE SAME HANDLE WAITS, and starts only once the first ends", async () => {
  const handle = handleFor('same');

  projectFor(handle);

  const runner = heldRunner();

  const first = runCommandFor(handle, 'slow', {}, { maxConcurrent: 1, run: runner.run });
  const second = runCommandFor(handle, 'slow', {}, { maxConcurrent: 1, run: runner.run });

  await settle();

  // The claim is that the second never REACHED the runner, not that it is slow.
  assert.equal(runner.started, 1, 'the cap let a second command start');

  runner.releaseOne();
  await first;
  await settle();

  assert.equal(runner.started, 2, 'the waiter was never woken when the slot freed');

  runner.releaseOne();
  await second;
});

test('a cap of 3 lets 3 start and holds the 4th', async () => {
  const handle = handleFor('three');

  projectFor(handle);

  const runner = heldRunner();
  const all = [0, 1, 2, 3].map(() =>
    runCommandFor(handle, 'slow', {}, { maxConcurrent: 3, run: runner.run }),
  );

  await settle();

  assert.equal(runner.started, 3);

  for (const _ of all) runner.releaseOne();
  await settle();
  runner.releaseOne();
  await Promise.all(all);
});

// ---------------------------------------------------------------------------
// The slot has to come back on every ending, not just the happy one
// ---------------------------------------------------------------------------

test('🛑 A FAILED COMMAND RETURNS ITS SLOT, so one failure does not wedge the handle', async () => {
  const handle = handleFor('failed');

  projectFor(handle);

  const boom = ((_f, _a, _o, cb) => {
    cb(Object.assign(new Error('killed'), { killed: true }), '', '');
  }) as ScriptRunner;

  await assert.rejects(runCommandFor(handle, 'slow', {}, { maxConcurrent: 1, run: boom }));

  // Would hang rather than fail if the permit leaked, so the assertion is that
  // this resolves at all.
  const runner = heldRunner();
  const next = runCommandFor(handle, 'slow', {}, { maxConcurrent: 1, run: runner.run });

  await settle();

  assert.equal(runner.started, 1, 'the failed command never gave its slot back');

  runner.releaseOne();
  await next;
});

test('🛑 A REFUSED NAME TAKES NO SLOT AT ALL, so it never queues behind running work', async () => {
  const handle = handleFor('refused');

  projectFor(handle);

  const runner = heldRunner();
  const held = runCommandFor(handle, 'slow', {}, { maxConcurrent: 1, run: runner.run });

  await settle();

  // The slot is occupied. A bad name must still be refused immediately rather
  // than waiting for it.
  await assert.rejects(
    runCommandFor(handle, 'no-such-command', {}, { maxConcurrent: 1, run: runner.run }),
    /no command/,
  );

  runner.releaseOne();
  await held;
});

test('a cap below 1 is read as 1 rather than waiting forever', async () => {
  const handle = handleFor('zero');

  projectFor(handle);

  const runner = heldRunner();
  const only = runCommandFor(handle, 'slow', {}, { maxConcurrent: 0, run: runner.run });

  await settle();

  assert.equal(runner.started, 1, 'a cap of 0 deadlocked instead of clamping to 1');

  runner.releaseOne();
  await only;
});
