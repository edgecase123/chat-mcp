import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), 'chat-mcp-graceful-stop-'));

const { migrate } = await import('../../src/storage/db.js');
const { startSupervisor } = await import('../../src/supervise/index.js');
import { supervisorOptions } from '../support/supervisor-options.js';

const DIRS = [process.cwd()];

interface FakeChild {
  sent: string[];
  killed: boolean;
  finishTurn: () => void;
}

function recordingChild(children: FakeChild[]) {
  return () => {
    const sent: string[] = [];
    let endTurn: (() => void) | undefined;
    const rec: FakeChild = { sent, killed: false, finishTurn: () => endTurn?.() };
    children.push(rec);

    return {
      reportsUsage: false,
      send: (t: string) => sent.push(t),
      onTurnEnd: (cb: () => void) => {
        endTurn = cb;
      },
      onUsage: () => undefined,
      onDenial: () => undefined,
      onSession: () => undefined,
      onEvent: () => undefined,
      onExit: () => undefined,
      kill: () => {
        rec.killed = true;
      },
    };
  };
}

async function supervisorFor(
  handle: string,
  children: FakeChild[],
  shutdownGraceSeconds?: number,
) {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  return startSupervisor(supervisorOptions({
    handle,
    db,
    extraDirs: DIRS,
    spawnChild: recordingChild(children),
    log: () => undefined,
    shutdownGraceSeconds,
  }));
}

test('stop() with no mode kills immediately and sends no notice', async () => {
  const children: FakeChild[] = [];
  const sup = await supervisorFor(`stop-${process.pid}-default`, children);

  await sup.stop();

  assert.equal(children[0]?.killed, true);
  assert.equal(children[0]?.sent.length, 0, 'a bare stop() must not send a shutdown notice');
});

test("stop('now') kills immediately with no notice", async () => {
  const children: FakeChild[] = [];
  const sup = await supervisorFor(`stop-${process.pid}-now`, children);

  await sup.stop('now');

  assert.equal(children[0]?.killed, true);
  assert.equal(children[0]?.sent.length, 0);
});

test("stop('graceful') sends a shutdown notice and waits for its turn to end before killing", async () => {
  const children: FakeChild[] = [];
  const sup = await supervisorFor(`stop-${process.pid}-graceful`, children);

  const stopPromise = sup.stop('graceful');

  // The notice must be sent before kill() — give it a tick to land.
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(children[0]?.sent.length, 1, 'the shutdown notice was never sent');
  assert.match(children[0]?.sent[0] ?? '', /shutting down|externalize/i);
  assert.equal(children[0]?.killed, false, 'killed before the notice turn ended');

  children[0]?.finishTurn();
  await stopPromise;

  assert.equal(children[0]?.killed, true, 'never killed after the notice turn ended');
});

test("🛑 stop('graceful') kills on the grace TIMEOUT when the turn never ends", async () => {
  const children: FakeChild[] = [];
  // 🛑 THIS IS THE BRANCH THE 60s DEFAULT EXISTS FOR — a child that is hung,
  // crashed, or simply never ends its turn. The test above always calls
  // `finishTurn()`, so it resolves on the turn-end path and never reaches
  // `setTimeout(finish, timeoutMs)`. This one never finishes a turn, so only
  // the timeout can resolve `stop()`. Were that timer missing, this would
  // hang rather than assert — which is still a loud failure, not a pass.
  const sup = await supervisorFor(`stop-${process.pid}-timeout`, children, 0.05);

  await sup.stop('graceful');

  assert.equal(children[0]?.sent.length, 1, 'the notice must still be sent before the wait');
  assert.equal(children[0]?.killed, true, 'the grace timeout never fired, so a hung child survives');
});
