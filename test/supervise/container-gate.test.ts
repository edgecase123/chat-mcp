import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), 'chat-mcp-container-gate-'));

const { migrate } = await import('../../src/storage/db.js');
const { startSupervisor } = await import('../../src/supervise/index.js');
const { setToken } = await import('../../src/supervise/auth.js');
const { markConfirmed } = await import('../../src/supervise/container.js');
import { supervisorOptions } from '../support/supervisor-options.js';

const DIRS = [process.cwd()];

function supervisorDb() {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  return db;
}

test('a container supervisor with no token fails fast naming the fix', async () => {
  const db = supervisorDb();
  const handle = `cg-${process.pid}-notoken`;
  markConfirmed(handle);

  await assert.rejects(
    () =>
      startSupervisor(supervisorOptions({
        handle,
        db,
        extraDirs: DIRS,
        driver: 'docker-claude',
        reply: false,
        log: () => undefined,
      })),
    /chat-mcp auth set-token/,
  );
});

test('an UNCONFIRMED container handle refuses to spawn without --now-style override', async () => {
  const db = supervisorDb();
  const handle = `cg-${process.pid}-unconfirmed`;
  setToken('sk-ant-oat-x');

  await assert.rejects(
    () =>
      startSupervisor(supervisorOptions({
        handle,
        db,
        extraDirs: DIRS,
        driver: 'docker-claude',
        reply: false,
        log: () => undefined,
      })),
    /not confirmed/,
  );
});

test('a CONFIRMED handle with a token spawns via the docker driver', async () => {
  const db = supervisorDb();
  const handle = `cg-${process.pid}-ok`;
  setToken('sk-ant-oat-x');
  markConfirmed(handle);

  const spawned: unknown[] = [];
  const sup = await startSupervisor(supervisorOptions({
    handle,
    db,
    extraDirs: DIRS,
    driver: 'docker-claude',
    reply: false,
    log: () => undefined,
    spawnChild: (opts) => {
      spawned.push(opts);
      return {
        reportsUsage: false,
        send: () => undefined,
        onTurnEnd: () => undefined,
        onContext: () => undefined,
        onUsage: () => undefined,
        onDenial: () => undefined,
        onSession: () => undefined,
        onEvent: () => undefined,
        onExit: () => undefined,
        kill: () => undefined,
      };
    },
  }));

  try {
    assert.equal(spawned.length, 1);
  } finally {
    await sup.stop();
  }
});
