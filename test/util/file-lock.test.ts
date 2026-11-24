import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 🛑 BEFORE any import that resolves a state path.
process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), "chat-mcp-file-lock-"));

const { withFileLock } = await import("../../src/util/file-lock.js");

import { deadPid } from "../support/dead-pid.js";
import { isProcessAlive } from "../../src/util/process.js";

/**
 * `withFileLock`'s own properties, driven DIRECTLY.
 *
 * 🛑 THEY USED TO BE PINNED THROUGH `container.ts`'s SEAM ONLY, in a file
 * named `container-state-lock`. Two state files now take this lock, so the day
 * `container.json` stops using it that file goes with it and `agents.json`
 * silently loses the robbed-holder, dead-pid and empty-lock guarantees with
 * nothing turning red. Raised by claude2 on PR 437.
 *
 * ⚠️ EACH CALLER'S OWN TEST STILL PROVES THAT IT TAKES THE LOCK. What moved
 * here is what the lock DOES once taken.
 */

const HOME = process.env.CHAT_MCP_HOME;

/** A fresh lock path per test, so one test's wreckage cannot pass the next. */
let n = 0;
function lockPath(): string {
  return join(HOME, `probe-${n++}.lock`);
}

test("🛑 a lock held by a dead process is broken", () => {
  const path = lockPath();
  const dead = deadPid();

  // The premise, asserted rather than assumed — `dead-pid.ts` explains why.
  assert.ok(dead > 0);

  writeFileSync(path, `${dead}\n`);

  assert.equal(
    withFileLock(path, () => "ran"),
    "ran",
    "a dead holder's lock blocked the section",
  );
  assert.equal(existsSync(path), false, "the broken lock was not cleaned up");
});

/**
 * 🛑 THE CONTROL THAT MAKES THE ONE ABOVE MEAN ANYTHING. A lock broken
 * unconditionally would pass it and would reintroduce the defect — two writers
 * would simply take turns stealing each other's lock.
 *
 * This process is alive, so its own pid in the lock must be waited for and
 * then refused.
 */
test("🛑 a lock held by a LIVE process is refused, not stolen", () => {
  const path = lockPath();

  writeFileSync(path, `${process.pid}\n`);

  let ran = false;

  assert.throws(() => withFileLock(path, () => (ran = true)), /waiting for/);

  assert.equal(ran, false, "the section ran despite a live holder");
  assert.equal(
    readFileSync(path, "utf8").trim(),
    String(process.pid),
    "the live holder's lock was overwritten",
  );

  rmSync(path, { force: true });
});

/**
 * 🛑 AN EMPTY OR UNPARSEABLE LOCK READS AS ALIVE, AND THAT IS THE WHOLE
 * CORRECTNESS ARGUMENT. Writing the file is not instantaneous, so a lock
 * caught mid-creation holds no pid yet. Reading that as dead lets two
 * processes break each other's fresh locks.
 */
test("🛑 an empty or unparseable lock file is treated as a live holder", () => {
  const path = lockPath();

  for (const content of ["", "not-a-pid", "-1", "0"]) {
    writeFileSync(path, content);

    assert.throws(
      () => withFileLock(path, () => "should not run"),
      /waiting for/,
      `a lock containing ${JSON.stringify(content)} was broken`,
    );
  }

  rmSync(path, { force: true });
});

/**
 * 🛑 A ROBBED HOLDER MUST NOT DELETE THE LOCK THAT REPLACED ITS OWN.
 *
 * An unconditional `rmSync` on release deletes a robber's LIVE lock, and a
 * third writer then walks in beside the robber. The release is conditional on
 * the lock still naming us.
 */
test("🛑 a robbed holder does not delete the lock that replaced its own", () => {
  const path = lockPath();
  const robber = 1; // init. Alive on every platform this runs on.

  assert.equal(isProcessAlive(robber), true, "pid 1 reads as dead");

  withFileLock(path, () => {
    // The robbery, mid-section: someone else's pid is now in our lock.
    writeFileSync(path, `${robber}\n`);
  });

  assert.equal(
    readFileSync(path, "utf8").trim(),
    String(robber),
    "the robbed holder deleted or overwrote the robber's lock",
  );

  rmSync(path, { force: true });
});

/**
 * 🛑 A THROW INSIDE THE SECTION MUST LEAVE NO LOCK BEHIND.
 *
 * A lock left by a throwing writer bricks every later write for the whole
 * wait budget and then throws a timeout naming a live process — the most
 * misleading error this code can produce.
 */
test("🛑 a throw inside the lock releases it", () => {
  const path = lockPath();

  assert.throws(
    () =>
      withFileLock(path, () => {
        throw new Error("boom");
      }),
    /boom/,
  );

  assert.equal(existsSync(path), false, "a throwing section left its lock");

  // The positive half: the lock is reusable, not merely absent.
  assert.equal(
    withFileLock(path, () => "taken again"),
    "taken again",
  );
  assert.equal(existsSync(path), false);
});
