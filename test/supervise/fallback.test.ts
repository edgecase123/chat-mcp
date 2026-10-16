import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), 'chat-mcp-fb-'));

const { notifyPeer } = await import('../../src/notify/bus.js');
const { WakeListener } = await import('../../src/supervise/socket.js');
const { notifyPathFor } = await import('../../src/util/paths.js');

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 150));

test('with NO supervisor, notifyPeer still writes the notify file', async () => {
  // The fallback. Breaking this breaks the only wake claude1 and claude2 have.
  notifyPeer('lonely', { id: 1, to: 'lonely', from: 'claude1', ts: 99 });
  await settle();

  assert.ok(existsSync(notifyPathFor('lonely')));
  assert.deepEqual(JSON.parse(readFileSync(notifyPathFor('lonely'), 'utf8')), {
    id: 1,
    to: 'lonely',
    from: 'claude1',
    ts: 99,
  });
});

test('notifyPeer is SYNCHRONOUS and returns undefined, not a promise', () => {
  // ~30 call sites across 10 files do not await it. If this ever returns a
  // promise they all become unhandled-rejection sites silently.
  const returned = notifyPeer('sync-check', { id: 2, to: 'sync-check', from: 'x', ts: 1 });

  assert.equal(returned, undefined);
});

test('with a supervisor listening, BOTH paths fire', async () => {
  const got: number[] = [];
  const l = await WakeListener.bind('both', (e) => {
    got.push(e.id);

    return { ok: true };
  });

  try {
    notifyPeer('both', { id: 7, to: 'both', from: 'claude1', ts: 5 });
    await settle();

    // The socket got it...
    assert.deepEqual(got, [7], 'the supervisor was not delivered to');
    // ...and the file was still written, so a harness watch also wakes.
    assert.equal(JSON.parse(readFileSync(notifyPathFor('both'), 'utf8')).id, 7);
  } finally {
    await l.close();
  }
});

test('a supervisor for ANOTHER handle is not delivered to', async () => {
  const got: number[] = [];
  const l = await WakeListener.bind('someone-else', (e) => {
    got.push(e.id);

    return { ok: true };
  });

  try {
    notifyPeer('not-them', { id: 9, to: 'not-them', from: 'claude1', ts: 1 });
    await settle();

    assert.deepEqual(got, [], 'delivery leaked to the wrong handle');
  } finally {
    await l.close();
  }
});

test('a bare notifyPeer with no envelope still reaches a supervisor', async () => {
  const got: unknown[] = [];
  const l = await WakeListener.bind('bare', (e) => {
    got.push(e);

    return { ok: true };
  });

  try {
    notifyPeer('bare');
    await settle();

    // id 0 is the "no specific message" marker; `to` must still be the handle
    // or the supervisor cannot tell who it was for.
    assert.equal(got.length, 1);
    assert.equal((got[0] as { to: string }).to, 'bare');
  } finally {
    await l.close();
  }
});

test('the BODY reaches a supervisor, so the agent needs no inbox tool call', async () => {
  // 🛑 The point of the whole change. Without the body a woken agent must
  // call inbox/room_inbox before it can act, and that is a full model
  // round-trip carrying the entire context, on every wake.
  const got: (string | undefined)[] = [];
  const l = await WakeListener.bind('withbody', (e) => {
    got.push(e.body);

    return { ok: true };
  });

  try {
    notifyPeer('withbody', {
      id: 11,
      to: 'withbody',
      from: 'claude1',
      ts: 1,
      body: 'the actual chat message',
    });
    await settle();

    assert.deepEqual(got, ['the actual chat message']);
  } finally {
    await l.close();
  }
});

test('a sender with NO body still delivers, and the prompt says to read the inbox', async () => {
  const got: (string | undefined)[] = [];
  const l = await WakeListener.bind('nobody2', (e) => {
    got.push(e.body);

    return { ok: true };
  });

  try {
    notifyPeer('nobody2', { id: 12, to: 'nobody2', from: 'claude1', ts: 1 });
    await settle();

    assert.deepEqual(got, [undefined], 'a bodyless wake must still arrive');
  } finally {
    await l.close();
  }
});
