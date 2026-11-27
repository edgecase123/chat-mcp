/**
 * Publishing whether a supervised child can answer a DM (#475).
 *
 * 🛑 THE SUPERVISOR IS THE ONLY PROCESS THAT KNOWS. `--no-reply` yields no
 * grant, so the one tool a reply needs is absent — and that fact lives in
 * memory, in a process that does not own the child's `agents` row.
 *
 * 🛑 SO THE WRITE IS AN UPDATE AGAINST A ROW SOMEONE ELSE CREATES, AND AT
 * SUPERVISOR START IT DOES NOT EXIST YET. The shim writes it when the child
 * registers. An unretried write therefore publishes nothing on the common
 * path, which is the silent-no-op class `index.ts` already names for the
 * context gauge.
 */

/** A cancellable one-shot timer, injected so the retry gets a control. */
export interface ScheduledRetry {
  cancel(): void;
}

export interface CanReplyDeps {
  /** Writes the value, and reports whether a row took it. */
  readonly write: (value: number | null) => boolean;
  /** Read at every attempt, never cached — a restart can change the grant. */
  readonly canSend: () => boolean;
  readonly retryMs: number;
  readonly schedule?: (fn: () => void, ms: number) => ScheduledRetry;
}

export interface CanReplyPublisher {
  /** Publish the current answer. Returns whether a row took it. */
  publish(): boolean;
  /** Withdraw the answer, because nothing is publishing one any more. */
  clear(): void;
  /** Drop a pending retry without writing. */
  stop(): void;
}

function defaultSchedule(fn: () => void, ms: number): ScheduledRetry {
  const timer = setTimeout(fn, ms);
  // The retry must never be the reason the process stays alive.
  timer.unref?.();

  return { cancel: () => clearTimeout(timer) };
}

export function createCanReplyPublisher(deps: CanReplyDeps): CanReplyPublisher {
  const schedule = deps.schedule ?? defaultSchedule;
  let pending: ScheduledRetry | null = null;

  function cancelPending(): void {
    pending?.cancel();
    pending = null;
  }

  function attempt(): boolean {
    if (deps.write(deps.canSend() ? 1 : 0)) {
      cancelPending();

      return true;
    }

    // ONE timer regardless of how many callers ask, so a restart storm cannot
    // leave a fan of retries all writing the same value.
    if (!pending) {
      pending = schedule(() => {
        pending = null;
        attempt();
      }, deps.retryMs);
    }

    return false;
  }

  return {
    publish: attempt,
    clear: () => {
      cancelPending();

      // 🛑 NULL, NOT 0. A stopped supervisor is not a child that cannot reply,
      // it is nobody publishing an answer — and the sender must go ahead.
      //
      // 🛑 AND IT CANNOT THROW. This runs during teardown, BEFORE the socket
      // closes, and a throw here skipped that close — the socket then held the
      // event loop and a whole test file hung. Measured on `context-gauge`,
      // which closes its database on purpose.
      try {
        deps.write(null);
      } catch {
        // A withdrawal that cannot land is not worth failing a teardown over.
        // The row is stale either way, and `NULL` is the fail-open value.
      }
    },
    stop: cancelPending,
  };
}
