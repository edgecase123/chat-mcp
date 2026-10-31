import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NotifyBus, notifyPeer } from '../../src/notify/bus.js';

/**
 * 🛑 THE POLL REPLACED A FILE WATCH, ON lee's INSTRUCTION: *"I just don't
 * want file watchers"*. The watch was also the mechanism measured on #33 at
 * 8 of 10 signals LOST — ten writes produced two events.
 *
 * ⚠️ THE ADAPTIVE PART IS ABOUT LATENCY, NOT COST. Measured: one `statSync`
 * is 1392ns, so a flat 400ms poll costs 0.0125 SECONDS of CPU per hour. No
 * saving is being chased; the point is to be fast during a burst.
 */

function withTempHome<T>(fn: () => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'chat-mcp-poll-'));
  const previous = process.env.CHAT_MCP_HOME;
  process.env.CHAT_MCP_HOME = home;

  return fn().finally(() => {
    if (previous === undefined) delete process.env.CHAT_MCP_HOME;
    else process.env.CHAT_MCP_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('a subscriber fires on a real write', async () => {
  await withTempHome(async () => {
    const bus = new NotifyBus('probe');
    let fired = 0;
    bus.subscribe(() => {
      fired += 1;
    });

    notifyPeer('probe', { id: 1, to: 'probe', from: 't', ts: Date.now(), body: 'hi' });
    await sleep(600);
    await bus.close();

    assert.ok(fired > 0, 'the poll never noticed the write');
  });
});

test('it starts at the floor, so the first burst is fast', async () => {
  await withTempHome(async () => {
    const bus = new NotifyBus('probe');

    assert.equal(bus.pollIntervalMs, NotifyBus.MIN_POLL_MS);
    await bus.close();
  });
});

/**
 * 🛑 THE RELAXATION MUST BE BOUNDED. An unbounded backoff means a message
 * after a long quiet period waits an arbitrary time, which is the ambiguity
 * this whole bus argues against.
 */
test('it relaxes while idle and never passes the ceiling', async () => {
  await withTempHome(async () => {
    const bus = new NotifyBus('probe');

    await sleep(1500);
    const relaxed = bus.pollIntervalMs;

    assert.ok(relaxed > NotifyBus.MIN_POLL_MS, `it never backed off (${relaxed}ms)`);
    assert.ok(relaxed <= NotifyBus.MAX_POLL_MS, `it passed the ceiling (${relaxed}ms)`);

    await bus.close();
  });
});

/**
 * 🚨 THE PROPERTY THAT MAKES BACKOFF SAFE. If activity did not reset the
 * interval, a burst arriving after a quiet spell would be delivered at the
 * SLOWEST rate — exactly backwards.
 */
test('activity resets the interval to the floor', async () => {
  await withTempHome(async () => {
    const bus = new NotifyBus('probe');

    // ⚠️ SAMPLED AT FIRE TIME, not afterwards. The first version slept past
    // the burst and read the interval once it had relaxed AGAIN — it was
    // measuring the backoff it had just waited through.
    let atFire: number | null = null;
    bus.subscribe(() => {
      atFire ??= bus.pollIntervalMs;
    });

    await sleep(1500);
    const relaxed = bus.pollIntervalMs;
    assert.ok(relaxed > NotifyBus.MIN_POLL_MS, 'it never backed off to begin with');

    notifyPeer('probe', { id: 2, to: 'probe', from: 't', ts: Date.now(), body: 'burst' });
    await sleep(NotifyBus.MAX_POLL_MS + 300);
    await bus.close();

    assert.equal(atFire, NotifyBus.MIN_POLL_MS, 'a burst did not speed it back up');
  });
});

test('the bounds are sane: a floor below the ceiling, both positive', () => {
  assert.ok(NotifyBus.MIN_POLL_MS > 0);
  assert.ok(NotifyBus.MIN_POLL_MS < NotifyBus.MAX_POLL_MS);
  assert.ok(NotifyBus.BACKOFF > 1, 'a backoff of 1 or less never relaxes');
});

/**
 * ⚠️ `setTimeout` RE-ARMS ITSELF, so a close that misses leaves a timer
 * polling a deleted file forever.
 */
test('close stops the loop', async () => {
  await withTempHome(async () => {
    const bus = new NotifyBus('probe');
    let fired = 0;
    bus.subscribe(() => {
      fired += 1;
    });

    await bus.close();
    notifyPeer('probe', { id: 3, to: 'probe', from: 't', ts: Date.now(), body: 'after close' });
    await sleep(600);

    assert.equal(fired, 0, 'the bus fired after close');
  });
});
