import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 🛑 BEFORE any import that resolves a state path. See replace-child.test.ts.
process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), 'chat-mcp-childerr-'));

const { migrate } = await import('../../src/storage/db.js');
const { startSupervisor } = await import('../../src/supervise/index.js');
import type { AgentChild, SpawnOptions } from '../../src/supervise/child.js';
import { supervisorOptions } from '../support/supervisor-options.js';

/**
 * 🛑 A CONTAINER DIED WITH ITS REASON PIPED TO A STREAM NOBODY READ.
 *
 * `spawnContainerized` passes `stdio: ['pipe','pipe','pipe']` and nothing ever
 * attached to `stderr`. The prelude chains on `&&`, so a failed `npm ci` means
 * no agent starts at all — and `npm` writes every one of its errors to stderr.
 * The refusal was correct and unexplainable.
 *
 * ⚠️ STDOUT IS NOT AN ALTERNATIVE. `child.ts`'s line parser drops a non-JSON
 * line on purpose, so prose written there vanishes just as silently.
 *
 * 🛑 THIS IS A PREREQUISITE FOR #234, NOT A NICETY. lee ruled a
 * `command -v shasum` check into the prelude that must REPORT without blocking
 * the spawn. With both channels dead, that check would have written into
 * nothing in both arms — a guard that always fails open.
 * #229 comment 6882003485.
 */

function harness() {
  const lines: string[] = [];
  let emitErr: ((chunk: string) => void) | undefined;

  const spawnChild = (_opts: SpawnOptions): AgentChild => ({
    reportsUsage: false,
    reportsContext: true,
    send: () => undefined,
    onTurnEnd: () => undefined,
    onContext: () => undefined,
    onUsage: () => undefined,
    onDenial: () => undefined,
    onSession: (cb) => cb('sess'),
    onEvent: () => undefined,
    onStderr: (cb) => {
      emitErr = cb;
    },
    onExit: () => undefined,
    kill: () => undefined,
  });

  return { lines, spawnChild, emit: () => emitErr };
}

async function supervisor(handle: string, h: ReturnType<typeof harness>) {
  const db = new DatabaseSync(':memory:');
  migrate(db);

  const sup = await startSupervisor(supervisorOptions({
    handle,
    db,
    extraDirs: [process.cwd()],
    spawnChild: h.spawnChild,
    log: (line: string) => h.lines.push(line),
  }));

  return { sup, db };
}

test('🚨 what the child wrote to stderr reaches the log', async () => {
  const h = harness();
  const { sup, db } = await supervisor(`cse-${process.pid}-a`, h);

  try {
    assert.ok(h.emit(), 'the supervisor never subscribed to stderr');
    h.emit()!('npm error code EACCES\n');

    assert.equal(
      h.lines.some((l) => l.includes('npm error code EACCES')),
      true,
      `stderr never reached the log; got ${JSON.stringify(h.lines)}`,
    );
  } finally {
    await sup.stop();
    db.close();
  }
});

/**
 * 🛑 THE LINE MUST BE MARKED AS THE CHILD'S. An unprefixed line in a log that
 * also carries the supervisor's own output reads as the supervisor saying it,
 * which is how a container's error gets attributed to the host.
 */
test('🚨 a stderr line is attributed to the child, not the supervisor', async () => {
  const h = harness();
  const { sup, db } = await supervisor(`cse-${process.pid}-b`, h);

  try {
    h.emit()!('boom\n');
    const line = h.lines.find((l) => l.includes('boom'));

    assert.ok(line, 'nothing logged');
    assert.match(line, /stderr/i, `the line does not say it came from stderr: ${line}`);
  } finally {
    await sup.stop();
    db.close();
  }
});

/** Multi-line output must not collapse into one unreadable entry. */
test('🚨 a multi-line stderr chunk is logged line by line', async () => {
  const h = harness();
  const { sup, db } = await supervisor(`cse-${process.pid}-c`, h);

  try {
    h.emit()!('first\nsecond\n');

    assert.equal(h.lines.filter((l) => /first|second/.test(l)).length, 2);
  } finally {
    await sup.stop();
    db.close();
  }
});

/**
 * ⚠️ THE NEGATIVE CONTROL. A logger that printed on every chunk regardless
 * would pass the tests above and would also spam a line per empty flush.
 */
test('🚨 an empty or whitespace-only chunk logs nothing', async () => {
  const h = harness();
  const { sup, db } = await supervisor(`cse-${process.pid}-d`, h);

  try {
    const before = h.lines.length;
    h.emit()!('');
    h.emit()!('   \n\n');

    assert.equal(h.lines.length, before, `logged ${JSON.stringify(h.lines.slice(before))}`);
  } finally {
    await sup.stop();
    db.close();
  }
});
