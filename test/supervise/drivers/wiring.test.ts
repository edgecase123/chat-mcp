import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { wireAgentChild } from '../../../src/supervise/drivers/wiring.js';
import { routeClaudeEvent } from '../../../src/supervise/drivers/claude.js';

function fakeProcess() {
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  const exitCbs: ((code: number | null, signal: string | null) => void)[] = [];

  return {
    stdout,
    stdin,
    on(event: string, cb: (code: number | null, signal: string | null) => void) {
      if (event === 'exit') exitCbs.push(cb);
    },
    kill() {
      for (const cb of exitCbs) cb(null, 'SIGTERM');
    },
  };
}

test('a turn-end event reaches every onTurnEnd subscriber', async () => {
  const proc = fakeProcess();
  const agent = wireAgentChild(proc as never, {
    routeEvent: routeClaudeEvent,
    encodeInput: (t) => `${t}\n`,
    reportsUsage: true,
    reportsContext: true,
  });

  let ends = 0;
  agent.onTurnEnd(() => {
    ends += 1;
  });
  agent.onTurnEnd(() => {
    ends += 1;
  });

  proc.stdout.write(`${JSON.stringify({ type: 'result' })}\n`);
  await new Promise((r) => setImmediate(r));

  assert.equal(ends, 2);
});

test('🛑 a LATE onSession subscriber still receives an id that already arrived', async () => {
  // A subscriber registered after the system init event would otherwise never
  // learn the session id, which is what makes a grant resumable.
  const proc = fakeProcess();
  const agent = wireAgentChild(proc as never, {
    routeEvent: routeClaudeEvent,
    encodeInput: (t) => `${t}\n`,
    reportsUsage: true,
    reportsContext: true,
  });

  proc.stdout.write(`${JSON.stringify({ type: 'system', session_id: 'abc' })}\n`);
  await new Promise((r) => setImmediate(r));

  let seen: string | null = null;
  agent.onSession((id) => {
    seen = id;
  });

  assert.equal(seen, 'abc');
});

test('the same session id is reported once, not on every event that repeats it', async () => {
  const proc = fakeProcess();
  const agent = wireAgentChild(proc as never, {
    routeEvent: routeClaudeEvent,
    encodeInput: (t) => `${t}\n`,
    reportsUsage: true,
    reportsContext: true,
  });

  const ids: string[] = [];
  agent.onSession((id) => ids.push(id));

  proc.stdout.write(`${JSON.stringify({ type: 'system', session_id: 'abc' })}\n`);
  proc.stdout.write(`${JSON.stringify({ type: 'assistant', session_id: 'abc' })}\n`);
  await new Promise((r) => setImmediate(r));

  assert.deepEqual(ids, ['abc']);
});

test('send writes the vendor envelope to stdin', () => {
  const proc = fakeProcess();
  const written: string[] = [];
  proc.stdin.on('data', (c: Buffer) => written.push(c.toString()));

  const agent = wireAgentChild(proc as never, {
    routeEvent: routeClaudeEvent,
    encodeInput: (t) => `ENVELOPE:${t}\n`,
    reportsUsage: true,
    reportsContext: true,
  });

  agent.send('ping');

  assert.deepEqual(written, ['ENVELOPE:ping\n']);
});
