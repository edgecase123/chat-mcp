import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { approvalsSignature } from '../../src/cli/web/server.js';

/**
 * 🛑 THE APPROVAL VIEW MUST NOT DEPEND ON A FILE WATCH.
 *
 * The SSE `wake` event is driven by `NotifyBus`, which is chokidar on the
 * notify file — measured on chat-mcp#33 at 8 of 10 signals LOST. For a chat
 * message a dropped signal costs latency. For an approval it costs
 * correctness: the card never appears and a supervised agent sits blocked
 * while the operator sees nothing.
 */

test('a changed pending set produces a changed signature', () => {
  assert.notEqual(approvalsSignature([{ id: 1 }]), approvalsSignature([{ id: 2 }]));
});

/**
 * 🚨 THE FAILURE A COUNT WOULD CAUSE. One approval answered and another
 * arriving inside the same interval leaves the count identical, so a
 * count-based check would never fire and the card would never refresh.
 */
test('swapping one approval for another is detected, though the COUNT is unchanged', () => {
  const before = [{ id: 7 }];
  const after = [{ id: 8 }];

  assert.equal(before.length, after.length, 'the count really is unchanged');
  assert.notEqual(approvalsSignature(before), approvalsSignature(after));
});

test('an unchanged set produces an unchanged signature, so the poll stays quiet', () => {
  assert.equal(approvalsSignature([{ id: 1 }, { id: 2 }]), approvalsSignature([{ id: 1 }, { id: 2 }]));
});

test('an empty set has a stable signature', () => {
  assert.equal(approvalsSignature([]), approvalsSignature([]));
  assert.notEqual(approvalsSignature([]), approvalsSignature([{ id: 1 }]));
});

/**
 * 🛑 READ FROM THE SOURCE, because a type error cannot catch a dependency.
 * If the approvals event ever becomes watch-driven again, the symptom is an
 * approval that silently never appears — which is indistinguishable from
 * there being no approval.
 */
test('the approvals event is driven by the POLL, never by the notify watch', () => {
  const src = readFileSync(new URL('../../src/cli/web/server.ts', import.meta.url), 'utf8');

  const pollBlock = src.slice(src.indexOf('const approvalPoll = setInterval'));
  assert.ok(pollBlock.length > 0, 'there is no poll at all');
  assert.ok(
    pollBlock.includes('event: approvals'),
    'the approvals event is not emitted from the poll',
  );

  // The notify subscription must not be what emits it.
  const subscribeBlock = src.slice(
    src.indexOf('notify.subscribe('),
    src.indexOf('const server = createServer'),
  );
  assert.ok(subscribeBlock.length > 0, 'the notify subscription moved; this check is stale');
  assert.ok(
    !subscribeBlock.includes('approvals'),
    'the approvals event is being emitted from the file-watch path',
  );
});

test('the poll is cleared on shutdown, so it cannot outlive the server', () => {
  const src = readFileSync(new URL('../../src/cli/web/server.ts', import.meta.url), 'utf8');

  assert.ok(src.includes('clearInterval(approvalPoll)'), 'the poll leaks past shutdown');
});
