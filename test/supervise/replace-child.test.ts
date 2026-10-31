import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { migrate } from '../../src/storage/db.js';
import type { AgentChild, SpawnOptions } from '../../src/supervise/child.js';
import { startSupervisor } from '../../src/supervise/index.js';
import { deliverToSupervisor } from '../../src/supervise/socket.js';

/**
 * 🛑 THE APPROVAL PATH LOOKED FIXED AND WAS NOT.
 *
 * The child was spawned ONCE. A grant recorded the command, sent the child a
 * prompt saying it was now allowed, and never changed its `--allowedTools`.
 * The next attempt would be denied again, and the prompt made the grant look
 * like it had worked. `grantedCommands` was written and never read.
 *
 * `tsc` cannot see a variable that is only ever pushed to, and the earlier
 * guard asserted the prompt was BUILT rather than that the flags CHANGED.
 */

const DIRS = [process.cwd()];

function recordingChild(spawns: SpawnOptions[]) {
  return (opts: SpawnOptions): AgentChild => {
    spawns.push(opts);

    return {
      reportsUsage: false,
      send: () => undefined,
      onTurnEnd: () => undefined,
      onUsage: () => undefined,
      onDenial: () => undefined,
      onSession: (cb) => cb('sess-from-fake'),
      onEvent: () => undefined,
      onExit: () => undefined,
      kill: () => undefined,
    };
  };
}

async function supervisorFor(handle: string, spawns: SpawnOptions[]) {
  const db = new DatabaseSync(':memory:');
  migrate(db);

  return startSupervisor({
    handle,
    db,
    extraDirs: DIRS,
    spawnChild: recordingChild(spawns),
    log: () => undefined,
  });
}

test('an APPROVAL respawns the child with the command added to its allowlist', async () => {
  const spawns: SpawnOptions[] = [];
  const sup = await supervisorFor(`rc-${process.pid}-a`, spawns);

  try {
    assert.equal(spawns.length, 1, 'the first child never spawned');
    assert.ok(!spawns[0]?.grant?.allowed.includes('Bash(rm:*)'), 'already granted before approval');

    await deliverToSupervisor(`rc-${process.pid}-a`, {
      id: 1,
      to: `rc-${process.pid}-a`,
      from: 'lee',
      ts: Date.now(),
      approval: {
        approvalId: 1,
        decision: 'approve',
        requested: 'Bash(rm:*)',
        sessionId: 'sess-1',
      },
    });

    assert.equal(spawns.length, 2, 'the child was NOT replaced — the grant never reached it');
    assert.ok(
      spawns[1]?.grant?.allowed.includes('Bash(rm:*)'),
      'the replacement child did not receive the granted command',
    );
  } finally {
    await sup.stop();
  }
});

/**
 * 🛑 A GRANT MUST NOT COST THE CHILD ITS MEMORY. Measured 2026-10-31:
 * `--resume` works 3 of 3 with the explicit prompt, so a permission round
 * trip is not a restart.
 */
test('the replacement RESUMES the session rather than starting a new one', async () => {
  const spawns: SpawnOptions[] = [];
  const sup = await supervisorFor(`rc-${process.pid}-b`, spawns);

  try {
    await deliverToSupervisor(`rc-${process.pid}-b`, {
      id: 2,
      to: `rc-${process.pid}-b`,
      from: 'lee',
      ts: Date.now(),
      approval: { approvalId: 2, decision: 'approve', requested: 'Bash(rm:*)', sessionId: 'x' },
    });

    assert.equal(spawns[1]?.resumeSessionId, 'sess-from-fake');
  } finally {
    await sup.stop();
  }
});

/**
 * ⚠️ A grant is ADDITIVE. One that replaced the list would revoke everything
 * the agent already had, mid-task, and the symptom would be a second denial
 * for something that worked a minute earlier.
 */
test('a grant keeps every tool the child already had', async () => {
  const spawns: SpawnOptions[] = [];
  const sup = await supervisorFor(`rc-${process.pid}-c`, spawns);

  try {
    const before = [...(spawns[0]?.grant?.allowed ?? [])];
    assert.ok(before.length > 0, 'the first child had no tools, so this proves nothing');

    await deliverToSupervisor(`rc-${process.pid}-c`, {
      id: 3,
      to: `rc-${process.pid}-c`,
      from: 'lee',
      ts: Date.now(),
      approval: { approvalId: 3, decision: 'approve', requested: 'Bash(rm:*)', sessionId: 'x' },
    });

    for (const tool of before) {
      assert.ok(spawns[1]?.grant?.allowed.includes(tool), `the grant revoked: ${tool}`);
    }
  } finally {
    await sup.stop();
  }
});

/** A DENY must not replace anything — nothing changed, so nothing respawns. */
test('a DENY does not respawn the child', async () => {
  const spawns: SpawnOptions[] = [];
  const sup = await supervisorFor(`rc-${process.pid}-d`, spawns);

  try {
    await deliverToSupervisor(`rc-${process.pid}-d`, {
      id: 4,
      to: `rc-${process.pid}-d`,
      from: 'lee',
      ts: Date.now(),
      approval: { approvalId: 4, decision: 'deny', requested: 'Bash(rm:*)', sessionId: 'x' },
    });

    assert.equal(spawns.length, 1, 'a refusal replaced the child for no reason');
  } finally {
    await sup.stop();
  }
});

/**
 * 🛑 THE SEAM FOR A MODEL SWITCH, which lee asked to be easy to bolt on. A
 * switch is a CALLER of the same operation, so what this asserts is that the
 * operation carries `model` through at all.
 */
test('replaceChild carries a model change, so a switch is a caller not new machinery', () => {
  const src = readFileSync(new URL('../../src/supervise/index.ts', import.meta.url), 'utf8');

  assert.match(src, /allowedTools\?: readonly string\[\]; model\?: string/);
  assert.ok(src.includes('model: currentModel'), 'the replacement never passes a model');
});
