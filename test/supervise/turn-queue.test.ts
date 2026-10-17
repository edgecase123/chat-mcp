import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TurnQueue, type QueuedPrompt } from '../../src/supervise/turn-queue.js';

function recorder(): { sent: QueuedPrompt[]; queue: TurnQueue } {
  const sent: QueuedPrompt[] = [];
  const queue = new TurnQueue({ send: (p) => sent.push(p) });

  return { sent, queue };
}

const p = (text: string, ...ids: number[]): QueuedPrompt => ({ text, messageIds: ids });

test('the first prompt goes out immediately', () => {
  const { sent, queue } = recorder();

  assert.equal(queue.offer(p('one', 1)), 'sent');
  assert.deepEqual(sent.map((s) => s.text), ['one']);
});

test('a second prompt arriving mid-turn is QUEUED, not written', () => {
  const { sent, queue } = recorder();

  queue.offer(p('one', 1));
  assert.equal(queue.offer(p('two', 2)), 'queued');

  // 🛑 The measured bug: both written at once produced ONE turn. Exactly one
  // prompt may be in flight.
  assert.deepEqual(sent.map((s) => s.text), ['one']);
  assert.equal(queue.depth, 1);
});

test('the queued prompt is released by the result event', () => {
  const { sent, queue } = recorder();

  queue.offer(p('one', 1));
  queue.offer(p('two', 2));
  queue.turnEnded();

  assert.deepEqual(sent.map((s) => s.text), ['one', 'two']);
  assert.equal(queue.depth, 0);
});

test('the queue knows NO event shape — only the driver may end a turn', () => {
  // 🛑 This replaces two tests that fed `{type:'assistant'}` and `{}` in.
  // The queue no longer accepts events at all, which is the fix: it used to
  // sniff `type === 'result'`, so a Cursor driver — whose ACP returns a
  // `stopReason` on a JSON-RPC response — would never have ended a turn and
  // the supervisor would have hung after one message.
  const { sent, queue } = recorder();

  queue.offer(p('one', 1));
  queue.offer(p('two', 2));

  assert.equal(
    'onEvent' in (queue as unknown as Record<string, unknown>),
    false,
    'the queue must not take raw driver events',
  );
  assert.deepEqual(sent.map((s) => s.text), ['one']);

  queue.turnEnded();

  assert.deepEqual(sent.map((s) => s.text), ['one', 'two']);
});

test('the same bus message offered twice is dropped', () => {
  const { sent, queue } = recorder();

  queue.offer(p('one', 7));
  queue.turnEnded();

  // The notify file fires on every write, so the bus is re-read and message 7
  // comes back. Without de-duplication the agent is asked twice.
  assert.equal(queue.offer(p('one again', 7)), 'duplicate');
  assert.deepEqual(sent.map((s) => s.text), ['one']);
});

test('a partially-overlapping batch still sends, carrying only the new ids', () => {
  const { sent, queue } = recorder();

  queue.offer(p('first', 1));
  queue.turnEnded();

  assert.equal(queue.offer(p('1 and 2', 1, 2)), 'sent');
  assert.deepEqual(sent.map((s) => s.text), ['first', '1 and 2']);
});

test('a prompt carrying no message ids is never deduplicated', () => {
  const { sent, queue } = recorder();

  // The bootstrap prompt has no bus message behind it.
  assert.equal(queue.offer(p('boot')), 'sent');
  queue.turnEnded();
  assert.equal(queue.offer(p('boot')), 'sent');
  assert.equal(sent.length, 2);
});

test('draining returns what was never written and resets the state', () => {
  const { queue } = recorder();

  queue.offer(p('one', 1));
  queue.offer(p('two', 2));
  queue.offer(p('three', 3));

  const unsent = queue.drain();

  assert.deepEqual(unsent.map((u) => u.text), ['two', 'three']);
  assert.equal(queue.currentState, 'idle');
  assert.equal(queue.depth, 0);
});

test('a result with an empty queue leaves it idle, not stuck', () => {
  const { queue } = recorder();

  queue.offer(p('one', 1));
  queue.turnEnded();

  assert.equal(queue.currentState, 'idle');
  assert.equal(queue.offer(p('two', 2)), 'sent');
});
