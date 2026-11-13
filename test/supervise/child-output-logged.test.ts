import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 🛑 BEFORE any import that resolves a state path. See replace-child.test.ts.
process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), 'chat-mcp-childlog-'));

const { migrate } = await import('../../src/storage/db.js');
const { startSupervisor } = await import('../../src/supervise/index.js');
import type { AgentChild, SpawnOptions } from '../../src/supervise/child.js';
import { supervisorOptions } from '../support/supervisor-options.js';

/**
 * 🛑 THE SUPERVISOR LOGGED EVERY PROMPT IN AND NOTHING THE CHILD SAID BACK.
 *
 * A containerized agent was woken, ran a turn and answered nothing. The log
 * carried `→ child:`, `← turn complete; 0 queued, 0 held` and an exit code —
 * so "the agent replied somewhere we cannot see" and "the agent said nothing"
 * were indistinguishable, and two agents spent a session on the wrong half.
 *
 * `onEvent` already existed on `AgentChild` and nothing in `index.ts` called
 * it. The raw feed was there the whole time.
 */

function harness() {
  const lines: string[] = [];
  let emit: ((event: Record<string, unknown>) => void) | undefined;

  const spawnChild = (_opts: SpawnOptions): AgentChild => ({
    reportsUsage: false,
    send: () => undefined,
    onTurnEnd: () => undefined,
    onUsage: () => undefined,
    onDenial: () => undefined,
    onSession: (cb) => cb('sess'),
    onEvent: (cb) => {
      emit = cb;
    },
    onExit: () => undefined,
    kill: () => undefined,
  });

  return { lines, spawnChild, emitted: () => emit };
}

test('the supervisor logs the text the child produced', async () => {
  const db = new DatabaseSync(':memory:');
  migrate(db);

  const h = harness();

  const sup = await startSupervisor(supervisorOptions({
    handle: `childlog-${process.pid}`,
    db,
    extraDirs: [process.cwd()],
    spawnChild: h.spawnChild,
    log: (line: string) => h.lines.push(line),
  }));

  try {
    h.emitted()?.({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'I cannot reach the bus.' }] },
    });

    const said = h.lines.filter((l) => l.startsWith('← child:'));

    assert.equal(said.length, 1, `no child output was logged; lines were ${JSON.stringify(h.lines)}`);
    assert.match(said[0]!, /I cannot reach the bus\./);
  } finally {
    await sup.stop();
  }
});

test('the supervisor logs a tool call the child made, by name', async () => {
  const db = new DatabaseSync(':memory:');
  migrate(db);

  const h = harness();

  const sup = await startSupervisor(supervisorOptions({
    handle: `childtool-${process.pid}`,
    db,
    extraDirs: [process.cwd()],
    spawnChild: h.spawnChild,
    log: (line: string) => h.lines.push(line),
  }));

  try {
    h.emitted()?.({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'mcp__chat__send', input: { to: 'claude1' } }] },
    });

    const said = h.lines.filter((l) => l.startsWith('← child:'));

    assert.equal(said.length, 1, `no tool call was logged; lines were ${JSON.stringify(h.lines)}`);
    assert.match(said[0]!, /mcp__chat__send/);
  } finally {
    await sup.stop();
  }
});

/**
 * 🛑 THE TRUNCATION ITSELF COST A SESSION. `→ child:` cut at 80 characters
 * with newlines stripped, so an alert banner plus `[chat-mcp] <from>:` filled
 * the whole line and a reviewer read the message body as MISSING. It was not
 * missing; it was off the end.
 */
test('a truncated prompt log says it was truncated, and how long the text really was', async () => {
  const db = new DatabaseSync(':memory:');
  migrate(db);

  const h = harness();

  const sup = await startSupervisor(supervisorOptions({
    handle: `childtrunc-${process.pid}`,
    db,
    extraDirs: [process.cwd()],
    spawnChild: h.spawnChild,
    log: (line: string) => h.lines.push(line),
  }));

  try {
    h.emitted()?.({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'x'.repeat(5000) }] },
    });

    const said = h.lines.filter((l) => l.startsWith('← child:'));

    assert.equal(said.length, 1, 'no child output was logged');
    assert.match(said[0]!, /5000 chars/, `truncation was silent: ${said[0]}`);
  } finally {
    await sup.stop();
  }
});
