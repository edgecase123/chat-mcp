import { test } from "node:test";
import assert from "node:assert/strict";

import { createCanReplyPublisher } from "../../src/supervise/can-reply.js";

/**
 * #475. The supervisor is the only process that knows a child was started
 * with `--no-reply`, and it has to publish that on the child's `agents` row so
 * a SENDER can refuse before the DM is delivered.
 *
 * 🛑 THE ROW DOES NOT EXIST WHEN THE SUPERVISOR STARTS. It is written by the
 * SHIM when the child registers, so the first write changes 0 rows. The
 * context gauge in `startSupervisor` already names this class in its own
 * comment: an UPDATE against a missing row is a SILENT no-op.
 *
 * ⚠️ THE RETRY IS SCHEDULED THROUGH AN INJECTED CLOCK, so every case below is
 * a control rather than a sleep. A wall-clock test of a 1s retry is a flake.
 */

interface FakeClock {
  readonly scheduled: number;
  readonly cancelled: number;
  readonly pending: number;
  schedule(fn: () => void, ms: number): { cancel: () => void };
  fire(): void;
}

function fakeClock(): FakeClock {
  let scheduled = 0;
  let cancelled = 0;
  let queue: (() => void)[] = [];

  return {
    get scheduled() {
      return scheduled;
    },
    get cancelled() {
      return cancelled;
    },
    get pending() {
      return queue.length;
    },
    schedule(fn) {
      scheduled += 1;
      queue.push(fn);

      return {
        cancel: () => {
          cancelled += 1;
          queue = queue.filter((q) => q !== fn);
        },
      };
    },
    fire() {
      const due = queue;
      queue = [];
      for (const fn of due) fn();
    },
  };
}

/** A row that only exists once the test says the child registered. */
function fakeRow() {
  const writes: (number | null)[] = [];
  let exists = false;

  return {
    writes,
    register: () => {
      exists = true;
    },
    write: (value: number | null): boolean => {
      if (!exists) return false;
      writes.push(value);

      return true;
    },
  };
}

test("🚨 a child with no send tool publishes 0, and one with it publishes 1", () => {
  for (const [canSend, expected] of [
    [false, 0],
    [true, 1],
  ] as const) {
    const row = fakeRow();
    row.register();
    const clock = fakeClock();
    const pub = createCanReplyPublisher({
      write: row.write,
      canSend: () => canSend,
      retryMs: 1000,
      schedule: clock.schedule,
    });

    assert.equal(pub.publish(), true, "the write should have landed");
    assert.deepEqual(row.writes, [expected]);
    assert.equal(
      clock.scheduled,
      0,
      "a landed write must not schedule a retry",
    );
    pub.stop();
  }
});

/**
 * 🛑 THE CASE THE WHOLE TICKET TURNS ON. Without the retry the flag stays NULL
 * for the entire life of the child, every DM fails open, and #475 is unfixed
 * while every test of the refusal itself passes.
 */
test("🚨 an absent row RETRIES, and the retry lands once the child registers", () => {
  const row = fakeRow();
  const clock = fakeClock();
  const pub = createCanReplyPublisher({
    write: row.write,
    canSend: () => false,
    retryMs: 1000,
    schedule: clock.schedule,
  });

  assert.equal(pub.publish(), false, "there is no row yet");
  assert.deepEqual(row.writes, [], "nothing can have been written");
  assert.equal(clock.scheduled, 1, "the no-op must schedule a retry");

  clock.fire();
  assert.deepEqual(row.writes, [], "still no row, so still nothing written");
  assert.equal(clock.scheduled, 2, "a failed retry must schedule the next one");

  row.register();
  clock.fire();
  assert.deepEqual(
    row.writes,
    [0],
    "the retry did not publish on registration",
  );
  assert.equal(clock.pending, 0, "a landed write must stop the retry");
  pub.stop();
});

test("🚨 two failed publishes keep ONE retry, not one per call", () => {
  const row = fakeRow();
  const clock = fakeClock();
  const pub = createCanReplyPublisher({
    write: row.write,
    canSend: () => false,
    retryMs: 1000,
    schedule: clock.schedule,
  });

  pub.publish();
  pub.publish();
  assert.equal(clock.scheduled, 1, "the second call duplicated the timer");
  pub.stop();
});

/**
 * 🛑 CLEAR WRITES NULL, NOT 0. A stopped supervisor is not a child that cannot
 * reply — it is nobody publishing an answer, and the sender must go ahead.
 */
test("🚨 clear publishes NULL and cancels a pending retry", () => {
  const row = fakeRow();
  row.register();
  const clock = fakeClock();
  const pub = createCanReplyPublisher({
    write: row.write,
    canSend: () => false,
    retryMs: 1000,
    schedule: clock.schedule,
  });

  pub.publish();
  pub.clear();
  assert.deepEqual(row.writes, [0, null], "clear must publish NULL");
});

test("🚨 stop cancels the retry, so a gone child stops being written", () => {
  const row = fakeRow();
  const clock = fakeClock();
  const pub = createCanReplyPublisher({
    write: row.write,
    canSend: () => false,
    retryMs: 1000,
    schedule: clock.schedule,
  });

  pub.publish();
  assert.equal(clock.pending, 1);
  pub.stop();
  assert.equal(clock.cancelled, 1, "stop did not cancel the pending retry");
  assert.equal(clock.pending, 0);

  clock.fire();
  assert.deepEqual(row.writes, [], "a cancelled retry must not write");
});
