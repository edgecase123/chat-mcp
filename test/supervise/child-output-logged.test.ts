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
const { deliverToSupervisor } = await import('../../src/supervise/socket.js');
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
    reportsContext: true,
    send: () => undefined,
    onTurnEnd: () => undefined,
    onContext: () => undefined,
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
 *
 * ⚠️ THIS COVERS THE OUTPUT SIDE. The PROMPT side has its own test below,
 * because an earlier version of this file was titled for `→ child:` and
 * asserted only on `← child:` — so `index.ts`'s prompt log was unpinned while
 * reading as covered. Found by claude2 on PR 209.
 */
test('a truncated line of CHILD OUTPUT says it was cut, and how long it really was', async () => {
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

/**
 * 🛑 THE PROMPT SIDE, PINNED. Nothing in `test/` asserted on the `→ child:`
 * line, so the 80-character cut that caused the false diagnosis could have
 * come back without a single test going red. Found by claude2 on PR 209.
 */
test('the prompt log carries the message BODY, not just the banner', async () => {
  const db = new DatabaseSync(':memory:');
  migrate(db);

  const h = harness();
  const handle = `childprompt-${process.pid}`;

  const sup = await startSupervisor(supervisorOptions({
    handle,
    db,
    extraDirs: [process.cwd()],
    spawnChild: h.spawnChild,
    log: (line: string) => h.lines.push(line),
  }));

  try {
    await deliverToSupervisor(handle, {
      id: 1,
      to: handle,
      from: 'lee',
      ts: Date.now(),
      kind: 'alert',
      body: 'the gate is red on main',
    });

    const prompts = h.lines.filter((l) => l.startsWith('→ child:'));

    assert.equal(prompts.length, 1, `no prompt was logged; lines were ${JSON.stringify(h.lines)}`);

    // ⚠️ AN ALERT ON PURPOSE. The banner is what pushed the body past 80.
    assert.match(prompts[0]!, /ALERT/, 'the alert banner is missing');
    assert.match(prompts[0]!, /the gate is red on main/, 'THE BODY WAS CUT OFF AGAIN');
  } finally {
    await sup.stop();
  }
});

/**
 * 🛑 A DEAD TURN MUST SAY SO, NOT PROVE ITSELF BY ABSENCE. A turn that
 * errors emits `result` and no `assistant` event, so before this the exact
 * failure under investigation logged nothing new at all.
 */
test('a failed turn logs its outcome instead of logging nothing', async () => {
  const db = new DatabaseSync(':memory:');
  migrate(db);

  const h = harness();

  const sup = await startSupervisor(supervisorOptions({
    handle: `childresult-${process.pid}`,
    db,
    extraDirs: [process.cwd()],
    spawnChild: h.spawnChild,
    log: (line: string) => h.lines.push(line),
  }));

  try {
    h.emitted()?.({ type: 'result', subtype: 'error_during_execution', is_error: true });

    const outcomes = h.lines.filter((l) => l.startsWith('← result:'));

    assert.equal(outcomes.length, 1, `the dead turn logged nothing; lines were ${JSON.stringify(h.lines)}`);
    assert.match(outcomes[0]!, /subtype=error_during_execution/);
    assert.match(outcomes[0]!, /is_error=true/);
  } finally {
    await sup.stop();
  }
});

/**
 * ⚠️ THE PAIRED CONTROL. Without it the assertion above passes against a
 * logger that prints `is_error=true` unconditionally.
 */
test('a successful turn logs is_error=false', async () => {
  const db = new DatabaseSync(':memory:');
  migrate(db);

  const h = harness();

  const sup = await startSupervisor(supervisorOptions({
    handle: `childok-${process.pid}`,
    db,
    extraDirs: [process.cwd()],
    spawnChild: h.spawnChild,
    log: (line: string) => h.lines.push(line),
  }));

  try {
    h.emitted()?.({ type: 'result', subtype: 'success', is_error: false });

    const outcomes = h.lines.filter((l) => l.startsWith('← result:'));

    assert.equal(outcomes.length, 1, 'the successful turn logged no outcome');
    assert.match(outcomes[0]!, /subtype=success/);
    assert.match(outcomes[0]!, /is_error=false/);
  } finally {
    await sup.stop();
  }
});
