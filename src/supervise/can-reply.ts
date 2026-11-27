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
  /**
   * Where a write that threw is reported.
   *
   * 🛑 IT IS NOT OPTIONAL IN SPIRIT. Both callers that swallow a throw do it
   * because the alternative is worse, and a swallow with nowhere to report
   * leaves a row still reading `can_reply = 0` for a child that is gone.
   */
  readonly onError?: (err: unknown) => void;
}

export interface CanReplyPublisher {
  /** Publish the current answer. Returns whether a row took it. */
  publish(): boolean;
  /**
   * Withdraw the answer, because nothing is publishing one any more. Also
   * cancels a pending retry, so this is the only teardown call needed.
   */
  clear(): void;
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

        // 🛑 THE RETRY HAS NO CALLER. A throw here is not a failed write, it is
        // an unhandled exception in a timer callback and it takes the process
        // with it. Found by claude2 reviewing PR 486, from source.
        //
        // 🛑 AND IT DOES NOT RESCHEDULE. The only thing that throws is a
        // database that has gone away, and that does not revive — retrying
        // would be a timer logging forever.
        try {
          attempt();
        } catch (e) {
          deps.onError?.(e);
        }
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
      } catch (e) {
        // A withdrawal that cannot land is not worth failing a teardown over.
        // It is worth SAYING: the row still reads 0, so DMs to a child that is
        // already gone keep being refused until something rewrites it.
        deps.onError?.(e);
      }
    },
  };
}
