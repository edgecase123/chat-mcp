import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';

// 🛑 BEFORE any import that resolves a state path. See replace-child.test.ts.
process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), 'chat-mcp-actwire-'));

const { migrate } = await import('../../src/storage/db.js');
const dao = await import('../../src/storage/dao.js');
const { startSupervisor } = await import('../../src/supervise/index.js');
const { childHandleFor } = await import('../../src/supervise/grant.js');
const { HANDSHAKE_PARAM } = await import('../../src/cli/web/credential.js');
const { stateDir } = await import('../../src/util/paths.js');
const { deadPid } = await import('../support/dead-pid.js');
import type { AgentChild, SpawnOptions } from '../../src/supervise/child.js';
import { supervisorOptions } from '../support/supervisor-options.js';

/**
 * #240 — the supervisor half of the activity pulse is WIRED here, and PR 244
 * shipped `activity.ts` and `/api/activity` with nothing calling either.
 *
 * 🛑 `activity.test.ts` COVERS THE REPORTER AND THIS COVERS THE WIRING. Both
 * were green while the two halves never met, which is the gap this closes:
 * every test there builds its own reporter, so none of them proves `onEvent`
 * reaches one.
 */

/** A web server that records every activity POST. */
async function recordingServer(): Promise<{
  port: number;
  seen: { handle: string; phase: string }[];
  close: () => Promise<void>;
}> {
  const seen: { handle: string; phase: string }[] = [];

  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url === '/api/activity') seen.push(JSON.parse(body));
      res.statusCode = 204;
      res.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));

  const addr = server.address();
  assert.ok(addr && typeof addr === 'object', 'the rig server did not bind a port');

  return {
    port: addr.port,
    seen,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * 🛑 THE PRODUCER'S STRING, NOT A TOKEN. `server.ts` writes `${url}?t=${token}`
 * to `web-handshake`, and a fixture holding a bare token is what hid the 401
 * this PR's first commit fixed.
 */
function publishWebServer(port: number): void {
  writeFileSync(
    join(stateDir(), 'web-handshake'),
    `http://127.0.0.1:${String(port)}/?${HANDSHAKE_PARAM}=tok\n`,
  );
}

/** Captures the callbacks the supervisor registers on each child. */
function harness() {
  const children: { event?: (e: unknown) => void; turnEnd?: () => void }[] = [];

  const spawnChild = (_opts: SpawnOptions): AgentChild => {
    const slot: { event?: (e: unknown) => void; turnEnd?: () => void } = {};

    children.push(slot);

    return {
      reportsUsage: false,
      reportsContext: false,
      send: () => undefined,
      onTurnEnd: (cb) => {
        slot.turnEnd = cb;
      },
      onUsage: () => undefined,
      onContext: () => undefined,
      onDenial: () => undefined,
      onSession: (cb) => cb('sess'),
      onEvent: (cb) => {
        slot.event = cb as (e: unknown) => void;
      },
      onStderr: () => undefined,
      onExit: () => undefined,
      kill: () => undefined,
    };
  };

  return { spawnChild, children };
}

/** Let the fire-and-forget POSTs land. They are deliberately not awaited. */
function settle(ms = 150): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const ASSISTANT = { type: 'assistant', parent_tool_use_id: null, message: {} };

/**
 * 🛑 THE CHILD HANDLE, NOT THE SUPERVISOR'S. `context-gauge.test.ts` pinned
 * the same thing off a live-bus measurement: `list_agents` shows
 * `<handle>-agent` and the supervisor handle is not listed at all. A pulse on
 * `opts.handle` would address a row the web UI never renders.
 */
test('🔴 a child event PULSES, and it pulses on the CHILD handle', async () => {
  const db = new DatabaseSync(':memory:');
  migrate(db);

  const handle = `actwire-${process.pid}`;
  dao.upsertAgent(db, { handle: childHandleFor(handle), pid: deadPid(), session_id: 'child' });

  const web = await recordingServer();
  publishWebServer(web.port);

  const h = harness();
  const sup = await startSupervisor(supervisorOptions({
    handle,
    db,
    extraDirs: [process.cwd()],
    spawnChild: h.spawnChild,
    log: () => undefined,
  }));

  try {
    h.children[0]?.event?.(ASSISTANT);
    await settle();

    assert.deepEqual(web.seen, [{ handle: childHandleFor(handle), phase: 'tick' }]);
  } finally {
    await sup.stop();
    await web.close();
  }
});

/**
 * 🛑 AN `end` IS WHAT CLEARS THE PULSE. Without this the dot runs to the 30s
 * failsafe on every turn, which reads as an agent that never finished.
 */
test('🔴 a turn end pulses `end`, and it is not swallowed by the tick throttle', async () => {
  const db = new DatabaseSync(':memory:');
  migrate(db);

  const handle = `actend-${process.pid}`;
  dao.upsertAgent(db, { handle: childHandleFor(handle), pid: deadPid(), session_id: 'child' });

  const web = await recordingServer();
  publishWebServer(web.port);

  const h = harness();
  const sup = await startSupervisor(supervisorOptions({
    handle,
    db,
    extraDirs: [process.cwd()],
    spawnChild: h.spawnChild,
    log: () => undefined,
  }));

  try {
    // Back to back, so the `end` arrives inside the tick's 250ms window.
    h.children[0]?.event?.(ASSISTANT);
    h.children[0]?.turnEnd?.();
    await settle();

    assert.deepEqual(
      web.seen.map((s) => s.phase),
      ['tick', 'end'],
      'the end was swallowed by the tick throttle',
    );
  } finally {
    await sup.stop();
    await web.close();
  }
});
