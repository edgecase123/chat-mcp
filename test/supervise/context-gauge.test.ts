import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 🛑 BEFORE any import that resolves a state path. See replace-child.test.ts.
process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), 'chat-mcp-gauge-'));

const { migrate } = await import('../../src/storage/db.js');
const dao = await import('../../src/storage/dao.js');
const { startSupervisor } = await import('../../src/supervise/index.js');
const { routeClaudeEvent } = await import('../../src/supervise/drivers/claude.js');
const { resetClaudeContextModel } = await import('../../src/supervise/drivers/claude-events.js');
const { childHandleFor } = await import('../../src/supervise/grant.js');
const { deadPid } = await import('../support/dead-pid.js');
import type { AgentChild, SpawnOptions } from '../../src/supervise/child.js';
import type { ContextSnapshot } from '../../src/supervise/context-gauge.js';
import { supervisorOptions } from '../support/supervisor-options.js';

/**
 * #213 — a containerized agent showed a blank gauge, because the figure is
 * pushed by a host Claude Code hook and a container has no hooks. The
 * supervisor already receives every `usage` block in the child's stream.
 */

/** Only the callbacks a context test needs; the rest are no-ops. */
function routed(events: Record<string, unknown>[]): ContextSnapshot[] {
  const seen: ContextSnapshot[] = [];

  for (const event of events) {
    routeClaudeEvent(event, {
      turnEnd: () => undefined,
      usage: () => undefined,
      context: (snapshot) => seen.push(snapshot),
    });
  }

  return seen;
}

const INIT_OPUS = { type: 'system', subtype: 'init', model: 'claude-opus-5', session_id: 's' };
const TURN = (used: number) => ({
  type: 'assistant',
  message: { usage: { input_tokens: used } },
});

test('a turn after init reports the live size against that model window', () => {
  const seen = routed([INIT_OPUS, TURN(118_783)]);

  assert.equal(seen.length, 1, 'the init event itself must not report a reading');
  assert.deepEqual(seen[0], {
    used: 118_783,
    total: 1_000_000,
    model: 'claude-opus-5',
    totalIsFallback: false,
  });
});

/**
 * 🛑 THE FALLBACK MUST BE DECLARED, NOT SILENT. `claude-sonnet-5-5` is the id
 * the running container reports and it is not in the published window table.
 * A wrong denominator that says so can be found; one that does not cannot.
 */
test('an unmapped model falls back to a megatoken and SAYS it fell back', () => {
  const seen = routed([{ ...INIT_OPUS, model: 'claude-sonnet-5-5' }, TURN(50_000)]);

  assert.equal(seen[0]?.total, 1_000_000);
  assert.equal(seen[0]?.totalIsFallback, true);
  assert.equal(seen[0]?.model, 'claude-sonnet-5-5');
});

test('a turn before any init still reports, with no model to name', () => {
  // A fresh process has seen no init. The module remembers one per session.
  resetClaudeContextModel();

  const seen = routed([TURN(7)]);

  assert.equal(seen[0]?.used, 7);
  assert.equal(seen[0]?.model, null);
  assert.equal(seen[0]?.totalIsFallback, true);
});

/**
 * ⚠️ A `result` EVENT CARRIES `usage` TOO. Reporting it as well is redundant
 * rather than double-counted, but only `assistant` matches the transcript
 * entry the host hook reads.
 */
test('a result event reports nothing, so host and container read the same event', () => {
  const seen = routed([INIT_OPUS, { type: 'result', message: { usage: { input_tokens: 999 } } }]);

  assert.deepEqual(seen, []);
});

function harness() {
  let context: ((snapshot: ContextSnapshot) => void) | undefined;

  const spawnChild = (_opts: SpawnOptions): AgentChild => ({
    reportsUsage: false,
    send: () => undefined,
    onTurnEnd: () => undefined,
    onUsage: () => undefined,
    onContext: (cb) => {
      context = cb;
    },
    onDenial: () => undefined,
    onSession: (cb) => cb('sess'),
    onEvent: () => undefined,
    onExit: () => undefined,
    kill: () => undefined,
  });

  return { spawnChild, report: () => context };
}

/**
 * 🛑 THE GAUGE BELONGS TO THE CHILD'S ROW, NOT THE SUPERVISOR'S. Verified on
 * the live bus: `list_agents` showed the null gauge on `claude2-agent`, and
 * `claude2` was not listed at all. Writing it to `opts.handle` would update a
 * row nobody reads and leave the blank exactly where it is.
 */
test('the reading lands on the CHILD handle that list_agents shows', async () => {
  const db = new DatabaseSync(':memory:');
  migrate(db);

  const handle = `ctxgauge-${process.pid}`;
  // The SHIM writes this row when the child registers on the bus. Nothing in
  // the supervisor creates it, and an UPDATE against a missing row is silent.
  dao.upsertAgent(db, {
    handle: childHandleFor(handle),
    pid: deadPid(),
    session_id: 'child',
  });
  const h = harness();
  const lines: string[] = [];

  const sup = await startSupervisor(supervisorOptions({
    handle,
    db,
    extraDirs: [process.cwd()],
    spawnChild: h.spawnChild,
    log: (line: string) => lines.push(line),
  }));

  try {
    h.report()?.({ used: 118_783, total: 1_000_000, model: 'claude-opus-5', totalIsFallback: false });

    const child = dao.getAgent(db, childHandleFor(handle));

    assert.equal(child?.context_used, 118_783, `child row was ${JSON.stringify(child)}`);
    assert.equal(child?.context_total, 1_000_000);
  } finally {
    await sup.stop();
  }
});

test('a fallback window is logged once, naming the id, not on every turn', async () => {
  const db = new DatabaseSync(':memory:');
  migrate(db);

  const handle = `ctxfall-${process.pid}`;
  dao.upsertAgent(db, { handle: childHandleFor(handle), pid: deadPid(), session_id: 'child' });
  const h = harness();
  const lines: string[] = [];

  const sup = await startSupervisor(supervisorOptions({
    handle,
    db,
    extraDirs: [process.cwd()],
    spawnChild: h.spawnChild,
    log: (line: string) => lines.push(line),
  }));

  try {
    const snapshot = { used: 1, total: 1_000_000, model: 'claude-sonnet-5-5', totalIsFallback: true };
    h.report()?.(snapshot);
    h.report()?.({ ...snapshot, used: 2 });
    h.report()?.({ ...snapshot, used: 3 });

    const warned = lines.filter((l) => l.includes('claude-sonnet-5-5'));

    assert.equal(warned.length, 1, `expected one warning, got ${JSON.stringify(warned)}`);
  } finally {
    await sup.stop();
  }
});

/**
 * 🛑 `setAgentContext` IS AN UPDATE, SO A MISSING ROW SWALLOWS THE WRITE. The
 * row is the shim's, written when the child registers on the bus, and a turn
 * can finish first. A silent no-op here is the same blank gauge #213 opened on.
 */
test('a reading before the child has registered says so rather than vanishing', async () => {
  const db = new DatabaseSync(':memory:');
  migrate(db);

  const handle = `ctxunreg-${process.pid}`;
  const h = harness();
  const lines: string[] = [];

  const sup = await startSupervisor(supervisorOptions({
    handle,
    db,
    extraDirs: [process.cwd()],
    spawnChild: h.spawnChild,
    log: (line: string) => lines.push(line),
  }));

  try {
    const snapshot = { used: 10, total: 1_000_000, model: 'claude-opus-5', totalIsFallback: false };
    h.report()?.(snapshot);
    h.report()?.(snapshot);

    const said = lines.filter((l) => l.includes('has not registered'));

    assert.equal(said.length, 1, `expected one notice, got ${JSON.stringify(lines)}`);
    assert.equal(dao.getAgent(db, childHandleFor(handle)), null, 'no row should have been created');
  } finally {
    await sup.stop();
  }
});

/**
 * 🛑 AN `init` WITH NO MODEL MUST CLEAR THE LAST SESSION'S WINDOW. Keeping it
 * would measure a new child against the previous child's denominator and
 * report a confident, wrong percentage instead of a declared fallback.
 */
test('a replacement session whose init names no model does not inherit the old window', () => {
  routed([{ type: 'system', subtype: 'init', model: 'claude-haiku-4-5', session_id: 'a' }]);

  const seen = routed([{ type: 'system', subtype: 'init', session_id: 'b' }, TURN(1_000)]);

  assert.equal(seen[0]?.model, null, 'the haiku window survived into the next session');
  assert.equal(seen[0]?.totalIsFallback, true);
  assert.equal(seen[0]?.total, 1_000_000);
});
