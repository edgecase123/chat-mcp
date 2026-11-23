import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { reapThenRemove } from "./reap.js";

/**
 * 🛑 THE REAL ENOTEMPTY IS NOT REPRODUCIBLE ON DEMAND. It needs a write to
 * land between one `rmSync` walk's readdir and its rmdir. So these tests
 * assert the ORDER that makes the race impossible, using a fake child whose
 * exit timing they control, and each one fails on the defect it names:
 *
 * | mutant                               | what reds              | how       |
 * | ------------------------------------ | ---------------------- | --------- |
 * | drop the `await` on exit             | the flushing child     | assertion |
 * | drop the `exitCode === null` guard   | both already-dead ones | never settles |
 * | drop the `signalCode === null` guard | the already-signalled one | never settles |
 * | drop the `rmSync`                    | all three              | assertion |
 *
 * ⚠️ "NEVER SETTLES" IS NOT THE `timeout` FIRING. Measured: `node:test`
 * reports `Promise resolution is still pending but the event loop has already
 * resolved` and CANCELS, in milliseconds. The `timeout` below is a backstop
 * for a mutant that leaves the loop busy, and nothing here reaches it.
 */

type Fake = EventEmitter & {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill(signal: NodeJS.Signals): boolean;
  /** Every signal this child was actually sent. */
  signals: NodeJS.Signals[];
};

function bare(): Fake {
  const child = new EventEmitter() as Fake;
  child.exitCode = null;
  child.signalCode = null;
  child.signals = [];
  child.kill = (signal) => {
    child.signals.push(signal);
    return true;
  };
  return child;
}

function tree(): string {
  const root = mkdtempSync(join(tmpdir(), "chat-mcp-reap-"));
  writeFileSync(join(root, "chat.db"), "already here\n");
  return root;
}

test("🛑 the tree is still there while the child is flushing, and gone after", async () => {
  const root = tree();
  const child = bare();

  // What the real child does: the signal lands, and its last write to the
  // state dir happens on a later tick, before the kernel reaps it.
  let dirAtFlush: boolean | null = null;
  child.kill = (signal) => {
    child.signals.push(signal);
    setImmediate(() => {
      dirAtFlush = existsSync(root);
      if (dirAtFlush) writeFileSync(join(root, "chat.db-wal"), "flushed\n");
      child.emit("exit");
    });
    return true;
  };

  await reapThenRemove(child, root);

  assert.deepEqual(child.signals, ["SIGKILL"]);
  assert.equal(
    dirAtFlush,
    true,
    "the tree was removed while the child was still writing to it",
  );
  assert.equal(existsSync(root), false, "the tree was left behind");
});

test(
  "🛑 a child that has already exited is neither signalled nor waited for",
  { timeout: 5_000 },
  async () => {
    const root = tree();
    const child = bare();
    child.exitCode = 0;

    // It emits no `exit`, because the real one already did. Waiting on a
    // second never settles, and the table above says what catches that.
    await reapThenRemove(child, root);

    assert.deepEqual(child.signals, []);
    assert.equal(existsSync(root), false, "the tree was left behind");
  },
);

test(
  "🛑 a child already killed by a signal is neither signalled nor waited for",
  { timeout: 5_000 },
  async () => {
    const root = tree();
    const child = bare();
    child.signalCode = "SIGTERM";

    await reapThenRemove(child, root);

    assert.deepEqual(child.signals, []);
    assert.equal(existsSync(root), false, "the tree was left behind");
  },
);
