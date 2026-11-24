import { readFileSync, rmSync } from "node:fs";

import { writePrivateFileSync } from "./paths.js";
import { isProcessAlive } from "./process.js";

/**
 * The advisory lock every read-modify-write of a JSON state file is taken
 * under.
 *
 * 🛑 EXTRACTED RATHER THAN COPIED. `container.json` and `agents.json` have the
 * same defect and the same remedy, and a second copy of a lock is a second
 * thing to get wrong — the two drift and only one of them gets the next fix.
 * The reasoning below was established on #377 against `container.json`; it is
 * not re-derived per caller.
 *
 * 🛑 ONE WINDOW IS LEFT OPEN ON PURPOSE, AND IT IS NARROWER THAN WHAT IT
 * REPLACES. Breaking a dead holder's lock cannot be made conditional on the
 * file's CONTENT with these primitives: there is no atomic "unlink only if it
 * still says what I read". So two processes that both find the same dead
 * holder can end up inside the section together and lose one write. Measured
 * both ways on PR 410 — with `rmSync` and with an atomic `renameSync` — and
 * the rename closes nothing, because it is atomic on the PATH and not on the
 * object at it.
 *
 * ⚠️ WHAT IS FIXED IS THE COMMON CASE, every write where no stale lock is in
 * play. Before it, ANY two overlapping writers lost one change.
 */

/** How long a LIVE holder is waited for before the update is abandoned. */
const LOCK_WAIT_MS = 2_000;

/** One pause between attempts. */
const LOCK_POLL_MS = 5;

/**
 * Pause without yielding.
 *
 * 🛑 EVERY CALLER ON THIS PATH IS SYNCHRONOUS, down to `readFileSync`, so
 * there is no event loop to await on. `Atomics.wait` on a throwaway buffer is
 * the only sync sleep in Node that does not spin a core.
 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** The pid named inside a lock file, or `null` if it does not name one. */
function lockHolderPid(path: string): number | null {
  let raw: string;

  try {
    raw = readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }

  const pid = Number.parseInt(raw, 10);

  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/**
 * Whether the process named inside the lock file is still running.
 *
 * 🛑 AN EMPTY OR UNPARSEABLE LOCK READS AS ALIVE, AND THAT IS THE WHOLE
 * CORRECTNESS ARGUMENT. Writing the file is not instantaneous, so a lock
 * caught mid-creation holds no pid yet. Reading that as dead lets two
 * processes break each other's fresh locks, which is a slower version of the
 * defect this lock exists to fix.
 */
function lockHolderIsAlive(path: string): boolean {
  const pid = lockHolderPid(path);

  // ⚠️ `null` IS "COULD NOT TELL", AND IT READS AS ALIVE.
  if (pid === null) return true;

  return isProcessAlive(pid);
}

/**
 * Take the lock, or throw having taken nothing.
 *
 * 🛑 LIVENESS IS CHECKED INSTEAD OF A STALE AGE BEING GUESSED. A `SIGKILL`ed
 * holder leaves its lock behind, and an age threshold has to choose between
 * breaking a slow writer's lock and bricking every write until a human deletes
 * a file. `process.kill(pid, 0)` answers it in one syscall, and its failure
 * mode is benign: pid reuse makes a dead holder read as alive, so the caller
 * waits and throws rather than losing a write.
 */
function acquire(path: string): void {
  const deadline = Date.now() + LOCK_WAIT_MS;

  for (;;) {
    try {
      // 🛑 ONE CALL, NOT `openSync` THEN `writeSync`. Two calls leave the lock
      // momentarily EMPTY, which is the case the liveness check has to treat
      // as alive.
      writePrivateFileSync(path, `${process.pid}\n`, "wx");
      return;
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `timed out after ${LOCK_WAIT_MS}ms waiting for ${path}. A live process ` +
          `holds it. If nothing is running, delete that file.`,
      );
    }

    // A dead holder is broken immediately and retried with no pause.
    if (lockHolderIsAlive(path)) sleepSync(LOCK_POLL_MS);
    else rmSync(path, { force: true });
  }
}

/**
 * Drop the lock, but only while it is still OURS.
 *
 * 🛑 AN UNCONDITIONAL `rmSync` HERE DELETES A ROBBER'S LIVE LOCK. Breaking a
 * dead holder's lock is not conditional on content, so a slow process can move
 * a lock that has already been replaced by a live one. The robbed holder then
 * reaches this line and, unlinking blindly, lets a THIRD writer in beside the
 * robber.
 */
function release(path: string): void {
  if (lockHolderPid(path) === process.pid) rmSync(path, { force: true });
}

/**
 * Run `fn` holding the lock at `path`, releasing it however `fn` ends.
 *
 * @param path the lock file, conventionally `<state file>.lock`
 */
export function withFileLock<T>(path: string, fn: () => T): T {
  acquire(path);

  try {
    return fn();
  } finally {
    release(path);
  }
}
