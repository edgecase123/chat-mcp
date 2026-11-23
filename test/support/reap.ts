import { rmSync } from "node:fs";

/**
 * Stopping a spawned child and THEN removing the tree it was writing to.
 *
 * #351. A teardown did `child.kill("SIGKILL")` and `rmSync` back to back in
 * one `finally`. `kill` SIGNALS a process, it does not REAP it, so a child
 * still flushing `chat.db-wal` could create a file inside the tree while
 * `rmSync` was walking it. `force: true` suppresses `ENOENT`, never
 * `ENOTEMPTY`, so the removal threw on top of a PASSING assertion.
 *
 * 🛑 THE COST WAS A MISATTRIBUTED GATE, NOT A FLAKY TEST. The throw arrives
 * attached to whatever diff happens to be in the tree, so the author spends a
 * round on a delta that cannot reach it. Three `npm test` runs on one
 * unchanged tree gave EXIT 1, EXIT 0, EXIT 0.
 *
 * ⚠️ A RETRY LOOP AROUND `rmSync` WOULD ALSO HIDE THE SYMPTOM. It was
 * rejected: it leaves the tree being deleted under a process still using it.
 *
 * 🛑 TEST INFRASTRUCTURE. Never import it from `src/`.
 */

/**
 * The slice of `ChildProcess` this needs.
 *
 * Narrow on purpose, so a test can hand over a fake whose exit timing it
 * controls. The real race is unreproducible on demand — it needs a write to
 * land inside one `rmSync` walk — so the fake is the only instrument that can
 * fail deterministically.
 */
export type Reapable = {
  /**
   * `undefined` when the spawn itself failed, so no process ever existed.
   *
   * ⚠️ OPTIONAL, NOT `number | undefined`. `ChildProcessByStdio` declares it
   * optional, and a required field here does not accept a real child.
   */
  readonly pid?: number | undefined;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  kill(signal: NodeJS.Signals): boolean;
  once(event: "exit", listener: () => void): unknown;
  /**
   * 🛑 PERSISTENT, AND `once` IS NARROWED TO `exit` SO THIS CANNOT BE UNDONE
   * BY HABIT. A `once("error")` is consumed when it fires. On a live child it
   * does not resolve, so a SECOND `error` reaches no listener and
   * `EventEmitter` THROWS. The one caller happens to hold its own persistent
   * handler, so the safety was OUTSIDE this module until now.
   */
  on(event: "error", listener: () => void): unknown;
};

/**
 * Kill `child`, wait for it to be reaped, then remove `root`.
 *
 * A child that has already exited is not signalled again and is not waited
 * for — there is no second `exit` event to wait on, so doing either would
 * hang the teardown instead of the one it fixes.
 */
export async function reapThenRemove(
  child: Reapable,
  root: string,
): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());

      // 🛑 AN `error` IS NOT A REAP. A failed spawn has no process, so there
      // is nothing to wait for and nothing to race. A child that DID spawn
      // still owes an `exit`, and resolving here would remove the tree from
      // under it — this bug again, in a quieter form.
      child.on("error", () => {
        if (child.pid === undefined) resolve();
      });
    });
  }

  rmSync(root, { recursive: true, force: true });
}
