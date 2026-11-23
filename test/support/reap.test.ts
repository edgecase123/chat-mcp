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
 * | mutant                                  | reds   | how                   |
 * | --------------------------------------- | ------ | --------------------- |
 * | `void` in place of the `await` on exit  | 2 of 5 | assertion             |
 * | drop the `exitCode === null` guard      | 4 of 5 | never settles         |
 * | drop the `signalCode === null` guard    | 3 of 5 | never settles         |
 * | drop the `rmSync`                       | 5 of 5 | assertion             |
 * | drop the `error` listener               | 2 of 5 | unhandled `error`     |
 * | make the `error` listener unconditional | 1 of 5 | assertion             |
 *
 * ⚠️ EVERY ROW WAS TYPECHECKED BEFORE IT WAS RUN. A mutant that does not
 * compile reds the file without measuring anything, and an earlier cut of
 * this table had one.
 *
 * ⚠️ "NEVER SETTLES" IS NOT THE `timeout` FIRING, AND ITS COUNT IS NOT A
 * BLAST RADIUS. Measured: `node:test` reports `Promise resolution is still
 * pending but the event loop has already resolved` and CANCELS every pending
 * test in the file, in milliseconds. So those two rows red siblings that the
 * defect does not reach. The `timeout` below is a backstop for a mutant that
 * leaves the loop busy, and nothing here reaches it.
 */

type Fake = EventEmitter & {
  pid: number | undefined;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill(signal: NodeJS.Signals): boolean;
  /** Every signal this child was actually sent. */
  signals: NodeJS.Signals[];
};

function bare(): Fake {
  const child = new EventEmitter() as Fake;
  child.pid = 4242;
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

test(
  "🛑 a spawn that never produced a process is not waited for",
  { timeout: 5_000 },
  async () => {
    const root = tree();
    const child = bare();
    child.pid = undefined;

    // What a failed spawn does: `error`, and never an `exit`. Waiting for one
    // would hang a teardown that has nothing to reap.
    child.kill = (signal) => {
      child.signals.push(signal);
      setImmediate(() => child.emit("error", new Error("spawn ENOENT")));
      return true;
    };

    await reapThenRemove(child, root);

    assert.equal(existsSync(root), false, "the tree was left behind");
  },
);

test(
  "🛑 a live child that errors on the signal still owes an exit, and the tree waits for it",
  { timeout: 5_000 },
  async () => {
    const root = tree();
    const child = bare();

    // An `error` from a child that DID spawn says nothing about whether it
    // has been reaped. Resolving on it would remove the tree from under a
    // live process, which is the defect this module exists to prevent.
    let dirAtExit: boolean | null = null;
    child.kill = (signal) => {
      child.signals.push(signal);
      setImmediate(() => {
        child.emit("error", new Error("kill EPERM"));
        setImmediate(() => {
          dirAtExit = existsSync(root);
          child.emit("exit");
        });
      });
      return true;
    };

    await reapThenRemove(child, root);

    assert.equal(
      dirAtExit,
      true,
      "the tree was removed on `error`, before the child had exited",
    );
    assert.equal(existsSync(root), false, "the tree was left behind");
  },
);
