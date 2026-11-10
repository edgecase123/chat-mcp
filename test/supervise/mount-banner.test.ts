import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), 'chat-mcp-mount-banner-'));

const { migrate } = await import('../../src/storage/db.js');
const { startSupervisor } = await import('../../src/supervise/index.js');
const { deliverToSupervisor } = await import('../../src/supervise/socket.js');
const { setToken } = await import('../../src/supervise/auth.js');
const { markConfirmed } = await import('../../src/supervise/container.js');
const { registerMount } = await import('../../src/supervise/mounts.js');

const DIRS = [process.cwd()];

function fakeChild(sent: string[]) {
  let endTurn: (() => void) | undefined;
  return {
    opts: undefined as unknown,
    reportsUsage: false,
    send: (t: string) => sent.push(t),
    onTurnEnd: (cb: () => void) => {
      endTurn = cb;
    },
    onUsage: () => undefined,
    onDenial: () => undefined,
    onSession: (cb: (id: string) => void) => cb('sess-1'),
    onEvent: () => undefined,
    onExit: () => undefined,
    kill: () => undefined,
    finishTurn: () => endTurn?.(),
  };
}

test('a fresh container spawn prepends the mount banner to the FIRST prompt only', async () => {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  const handle = `mb-${process.pid}`;
  setToken('sk-ant-oat-x');
  markConfirmed(handle);

  const extra = mkdtempSync(join(tmpdir(), 'chat-mcp-mb-extra-'));
  registerMount(handle, 'local-context', extra);

  const sent: string[] = [];
  const children: ReturnType<typeof fakeChild>[] = [];
  const sup = await startSupervisor({
    handle,
    db,
    extraDirs: DIRS,
    driver: 'docker-claude',
    container: true,
    log: () => undefined,
    spawnChild: () => {
      const c = fakeChild(sent);
      children.push(c);
      return c;
    },
  });

  try {
    await deliverToSupervisor(handle, { id: 1, to: handle, from: 'lee', ts: Date.now(), body: 'hi' });
    assert.match(sent[0] ?? '', /Mounted directories:.*local-context -> \/mnt\/local-context/s);

    children[0]?.finishTurn();
    await deliverToSupervisor(handle, { id: 2, to: handle, from: 'lee', ts: Date.now(), body: 'again' });
    assert.equal(sent.length, 2, 'the second prompt must actually have been sent');
    assert.match(sent[1] ?? '', /again/);
    assert.doesNotMatch(sent[1] ?? '', /Mounted directories:/, 'the banner must not repeat');
  } finally {
    await sup.stop();
  }
});

test('the docker-claude driver gets the mount banner even without an explicit container flag', async () => {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  const handle = `mb-driver-only-${process.pid}`;
  setToken('sk-ant-oat-x');
  markConfirmed(handle);

  const extra = mkdtempSync(join(tmpdir(), 'chat-mcp-mb-extra-'));
  registerMount(handle, 'local-context', extra);

  const sent: string[] = [];
  const sup = await startSupervisor({
    handle,
    db,
    extraDirs: DIRS,
    driver: 'docker-claude',
    log: () => undefined,
    spawnChild: () => fakeChild(sent),
  });

  try {
    await deliverToSupervisor(handle, { id: 1, to: handle, from: 'lee', ts: Date.now(), body: 'hi' });
    assert.equal(sent.length, 1, 'the prompt must actually have been sent');
    assert.match(sent[0] ?? '', /Mounted directories:.*local-context -> \/mnt\/local-context/s);
  } finally {
    await sup.stop();
  }
});

test('a non-container (bare host) spawn never gets a mount banner', async () => {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  const handle = `mb-bare-${process.pid}`;

  const sent: string[] = [];
  const sup = await startSupervisor({
    handle,
    db,
    extraDirs: DIRS,
    log: () => undefined,
    spawnChild: () => fakeChild(sent),
  });

  try {
    await deliverToSupervisor(handle, { id: 1, to: handle, from: 'lee', ts: Date.now(), body: 'hi' });
    assert.equal(sent.length, 1, 'the prompt must actually have been sent');
    assert.match(sent[0] ?? '', /hi/);
    assert.doesNotMatch(sent[0] ?? '', /Mounted directories:/);
  } finally {
    await sup.stop();
  }
});
