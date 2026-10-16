import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), 'chat-mcp-sup-'));

const { startSupervisor, formatPrompt } = await import('../../src/supervise/index.js');
const { claudeArgs, createLineParser } = await import('../../src/supervise/child.js');
const { deliverToSupervisor } = await import('../../src/supervise/socket.js');
import type { AgentChild, SpawnOptions } from '../../src/supervise/child.js';

/** A fake child. No process, no model, no money. */
function fakeChild(): { child: AgentChild; sent: string[]; finishTurn: () => void } {
  const sent: string[] = [];
  let emit: ((e: Record<string, unknown>) => void) | undefined;

  return {
    sent,
    finishTurn: () => emit?.({ type: 'result' }),
    child: {
      send: (t) => sent.push(t),
      onEvent: (cb) => {
        emit = cb;
      },
      onExit: () => undefined,
      kill: () => undefined,
    },
  };
}

const start = (handle: string, f: ReturnType<typeof fakeChild>) =>
  startSupervisor({
    handle,
    spawnChild: (_o: SpawnOptions) => f.child,
    log: () => undefined,
  });

const env = (id: number, body?: string, to = 'sup') => ({ id, to, from: 'claude1', ts: 1, body });

test('argv carries plan mode, denied prompts, AND --verbose', () => {
  const a = claudeArgs();

  assert.deepEqual(a.slice(0, 5), ['-p', '--verbose', '--output-format', 'stream-json', '--input-format']);
  // 🛑 Without --verbose the process exits 1, and no --help text says so.
  assert.ok(a.includes('--verbose'));
  assert.deepEqual(a.slice(a.indexOf('--permission-mode'), a.indexOf('--permission-mode') + 2), ['--permission-mode', 'plan']);
  assert.deepEqual(a.slice(a.indexOf('--permission-prompts'), a.indexOf('--permission-prompts') + 2), ['--permission-prompts', 'none']);
  assert.ok(!a.includes('--dangerously-skip-permissions'));
  assert.ok(!a.includes('bypassPermissions'));
});

test('a delivered message is written to the child as one prompt', async () => {
  const f = fakeChild();
  const s = await start('sup', f);

  try {
    const ack = await deliverToSupervisor('sup', env(1, 'hello there'));

    assert.deepEqual(ack, { ok: true, queued: 'sent' });
    assert.equal(f.sent.length, 1);
    assert.match(f.sent[0]!, /claude1/);
    assert.match(f.sent[0]!, /hello there/);
  } finally {
    await s.stop();
  }
});

test('a message arriving MID-TURN is queued and the ack says so', async () => {
  const f = fakeChild();
  const s = await start('midturn', f);

  try {
    assert.equal((await deliverToSupervisor('midturn', env(1, 'one')))?.queued, 'sent');
    assert.equal((await deliverToSupervisor('midturn', env(2, 'two')))?.queued, 'queued');

    // The measured bug: two writes at once produce ONE turn.
    assert.equal(f.sent.length, 1);
    assert.equal(s.queueDepth, 1);

    f.finishTurn();

    assert.equal(f.sent.length, 2);
    assert.equal(s.queueDepth, 0);
  } finally {
    await s.stop();
  }
});

test('the same message delivered twice is reported as a duplicate, not re-sent', async () => {
  const f = fakeChild();
  const s = await start('dup', f);

  try {
    await deliverToSupervisor('dup', env(5, 'once'));
    f.finishTurn();

    assert.equal((await deliverToSupervisor('dup', env(5, 'once')))?.queued, 'duplicate');
    assert.equal(f.sent.length, 1);
  } finally {
    await s.stop();
  }
});

test('a payload-less wake tells the agent to read its inbox rather than inventing a body', () => {
  const prompt = formatPrompt({ id: 3, to: 'claude2', from: 'claude1', ts: 1 });

  assert.match(prompt, /read your inbox/);
  assert.match(prompt, /no body/);
});

test('a room message names the room', () => {
  assert.match(formatPrompt({ id: 1, to: '#gate', from: 'claude1', ts: 1, body: 'x' }), /in #gate/);
});

test('the line parser holds back a partial line and never emits half an event', () => {
  const seen: Record<string, unknown>[] = [];
  const feed = createLineParser((e) => seen.push(e));

  feed('{"type":"sys');
  assert.equal(seen.length, 0, 'a partial line must not be emitted');

  feed('tem"}\n{"type":"result"}\n');
  assert.deepEqual(seen.map((s) => s.type), ['system', 'result']);
});

test('a non-JSON line on stdout is dropped, not fatal', () => {
  const seen: Record<string, unknown>[] = [];
  const feed = createLineParser((e) => seen.push(e));

  feed('not json at all\n{"type":"result"}\n');

  assert.deepEqual(seen.map((s) => s.type), ['result']);
});

test('an ALERT escalates in the prompt text, not in a field the agent may not read', () => {
  const p = formatPrompt({ id: 1, to: 'claude2', from: 'claude1', ts: 1, body: 'prod is down', kind: 'alert' });

  assert.match(p, /🚨 ALERT — BLOCKING/);
  assert.match(p, /handle it before anything queued behind it/);
  assert.match(p, /prod is down/);
});

test('a DISPATCH is marked as a hand-off, distinctly from an alert', () => {
  const p = formatPrompt({ id: 1, to: 'claude2', from: 'claude1', ts: 1, body: 'take bug 7', kind: 'dispatch' });

  assert.match(p, /📋 DISPATCH/);
  assert.ok(!/ALERT/.test(p), 'a dispatch must not read as an alert');
});

test('a plain chat gets NO banner', () => {
  const p = formatPrompt({ id: 1, to: 'claude2', from: 'claude1', ts: 1, body: 'hi', kind: 'chat' });

  assert.ok(!/ALERT/.test(p));
  assert.ok(!/DISPATCH/.test(p));
});

test('a missing kind is treated as chat, not as an alert', () => {
  // Fail quiet, not loud: an absent field must not manufacture urgency.
  const p = formatPrompt({ id: 1, to: 'claude2', from: 'claude1', ts: 1, body: 'hi' });

  assert.ok(!/ALERT/.test(p));
});

test('an alert with NO body still escalates AND still says to read the inbox', () => {
  // The fallback file path carries no body. An alert must not lose its
  // urgency just because it arrived that way.
  const p = formatPrompt({ id: 9, to: '#gate', from: 'claude1', ts: 1, kind: 'alert' });

  assert.match(p, /🚨 ALERT — BLOCKING/);
  assert.match(p, /read your inbox/);
  assert.match(p, /in #gate/);
});
