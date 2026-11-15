import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "chat-mcp-ident-required-"));
process.env.CHAT_MCP_HOME = home;

test.after(() => rmSync(home, { recursive: true, force: true }));

/**
 * #138 — a connection with no identity mark had no guard and said nothing.
 *
 * 🛑 `insertMessage` SKIPS the identity comparison when the mark is absent, so
 * an unmarked connection wrote into a replaced file for the life of the process
 * with no refusal and no warning. `openDb` produced one whenever its own stat
 * failed. Raised by claude1 reviewing PR 265.
 *
 * 🛑 THE MOCK IS THE FIXTURE HERE, NOT A SUBSTITUTE FOR ONE. The contract under
 * test is "the stat failed", so making the stat fail is the only way to state
 * it. That is the opposite of `send-into-replaced-file.test.ts`, where a mocked
 * stat would have proved the comparison was wired rather than that a replaced
 * database trips it — so that file renames real files and this one does not.
 *
 * ⚠️ THE REAL FIXTURE WAS CONSIDERED AND REJECTED: racing an `unlink` into the
 * window between `new DatabaseSync(path)` and the stat two lines below it.
 * There is no hook between those lines, so the race can only be attempted, not
 * arranged, and a test that usually loses the race reports PASS for the wrong
 * reason.
 */

/** A fresh `db.js`, resolving `node:fs` through whatever this test mocked. */
async function freshDbModule(seq: number) {
  return (await import(
    `../../src/storage/db.js?ident=${seq}`
  )) as typeof import("../../src/storage/db.js");
}

function withMissingFile(t: TestContext): void {
  const real = statSync;

  t.mock.module("node:fs", {
    namedExports: {
      ...fs,
      statSync: (path: string, ...rest: unknown[]) => {
        // Only the database file itself disappears. `ensureStateDir` and the
        // mode tightening stat other paths, and breaking those would make this
        // test fail somewhere other than the branch it is about.
        if (typeof path === "string" && path.endsWith("chat.db")) {
          const err = new Error(
            `ENOENT: no such file or directory, stat '${path}'`,
          ) as NodeJS.ErrnoException;
          err.code = "ENOENT";
          throw err;
        }

        return (real as (...a: unknown[]) => unknown)(path, ...rest);
      },
    },
  });
}

test("🚨 openDb REFUSES a connection whose file it cannot identify", async (t) => {
  withMissingFile(t);

  const { openDb } = await freshDbModule(1);

  let thrown: Error | null = null;

  try {
    openDb().close();
  } catch (e) {
    thrown = e as Error;
  }

  assert.ok(thrown, "openDb returned an unmarked connection");

  // ⚠️ THE SENTENCE IS PART OF THE ASSERTION. An unmarked connection is not a
  // bug in the caller's code, so the refusal has to name the state directory as
  // the thing that moved or the operator debugs the wrong process.
  assert.match(thrown.message, /vanished while it was being opened/);
  assert.match(thrown.message, /state directory/);
});

/**
 * 🛑 THE PAIRED CONTROL, AND WITHOUT IT THE TEST ABOVE PASSES ON AN `openDb`
 * THAT THROWS FOR EVERY CALLER. It runs in its own test so the module mock from
 * the first one is already restored.
 */
test("a NORMAL openDb does not throw, and the connection carries a mark", async () => {
  const { openDb, identityFor } = await freshDbModule(2);

  const db = openDb();

  try {
    const mark = identityFor(db);

    assert.ok(mark, "a healthy openDb handed back a connection with no mark");
    assert.equal(typeof mark.ino, "number");
    assert.ok(mark.ino > 0, `inode ${mark.ino} is not a real one`);
  } finally {
    db.close();
  }
});
