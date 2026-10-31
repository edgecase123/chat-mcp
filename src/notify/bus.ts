import { writeFileSync, existsSync, unlinkSync, statSync } from 'node:fs';
import { ensureNotifyDir, notifyPathFor } from '../util/paths.js';

type Callback = () => void;

export interface NotifyEnvelope {
  id: number;
  to: string;
  from: string;
  ts: number;
  /**
   * The message text, when the sender has it to hand.
   *
   * 🛑 THIS IS THE POINT OF THE WHOLE CHANGE. lee, 2026-10-16: *"if it could
   * contain the chat message body it would save the agent from calling
   * chat-mcp to get the message before processing it"*.
   *
   * Without it a woken agent must call `inbox` or `room_inbox` before it can
   * do anything — and that is a TOOL ROUND-TRIP, a full model call carrying
   * the entire context, on every single wake. With it, the turn starts with
   * the message already in the prompt.
   *
   * ⚠️ OPTIONAL on purpose. Some senders — room fan-outs, presence pings —
   * have no body. `formatPrompt` handles both, and a bodyless wake correctly
   * tells the agent to go and read its inbox.
   */
  body?: string;
  /**
   * An operator's answer to a permission request.
   *
   * Carried so a supervisor can act on it directly. Without it the answer
   * reaches the agent as a sentence and the re-dispatch template never runs.
   */
  approval?: {
    approvalId: number;
    decision: 'approve' | 'deny';
    requested: string;
    grant: string | null;
    sessionId: string | null;
  };
  /**
   * The coordination kind the sender chose: `chat`, `dispatch` or `alert`.
   *
   * 🛑 DROPPING THIS IS A CORRECTNESS BUG, NOT MISSING POLISH. This repo's
   * own tool description says `alert` *"tags it as blocking/high-severity and
   * surfaces it in the recipient CLI's alert lane"*. A wake that omits it
   * delivers a blocking alert as an ordinary message — the urgency is lost at
   * the exact layer built to deliver it faster.
   */
  kind?: string;
}

/**
 * Write an inbox event to a peer's notify file. Any process (any shim, the
 * CLI) can call this to signal that a message has arrived for `handle`.
 * Missing envelope falls back to a bare timestamp — mtime still fires
 * watchers for events that don't correspond to a specific message.
 */
export function notifyPeer(handle: string, envelope?: NotifyEnvelope): void {
  ensureNotifyDir();
  const payload = envelope ? JSON.stringify(envelope) : String(Date.now());
  writeFileSync(notifyPathFor(handle), payload);

  // 🛑 ALSO hand it straight to a supervisor, if one is listening.
  //
  // Both paths fire on purpose, and this is a SPIKE arrangement (#33). The
  // file wakes an agent running on a harness watch; the socket wakes a
  // supervised one. Running them side by side is what makes the comparison
  // possible — if the supervisor misses something, the file path still
  // catches it and the gap is visible.
  //
  // ⚠️ NOT awaited, and `notifyPeer` stays SYNCHRONOUS. There are ~30 call
  // sites across 10 files and none of them await it; making this async would
  // change every one of them. The cost is that the SENDER does not see the
  // ack — the supervisor still gets the payload, which is the half that
  // removes de-duplication.
  //
  // `deliverToSupervisor` resolves null on every failure rather than
  // rejecting, so there is nothing to reject here; the catch is belt and
  // braces against a throw from the filesystem probe.
  void import('../supervise/socket.js')
    .then(({ deliverToSupervisor }) =>
      deliverToSupervisor(handle, {
        id: envelope?.id ?? 0,
        to: envelope?.to ?? handle,
        from: envelope?.from ?? 'unknown',
        ts: envelope?.ts ?? Date.now(),
        body: envelope?.body,
        kind: envelope?.kind,
        approval: envelope?.approval,
      }),
    )
    .catch(() => undefined);
}

/**
 * Per-agent inbox listener. Each registered peer has its own notify file
 * under `~/.chat-mcp/notify/<handle>`; only writes to that file fire
 * subscribers. External watchers (Claude Code Monitor, Cursor /loop) can
 * target the same path — every event is guaranteed relevant, no filter
 * needed.
 */
export class NotifyBus {
  private readonly subs = new Set<Callback>();
  private readonly path: string;
  private timer: NodeJS.Timeout;
  private seen: string;
  private interval: number;
  private closed = false;

  /**
   * Poll bounds. The interval RESETS to the floor on any activity and
   * relaxes toward the ceiling while nothing happens.
   *
   * 🛑 THIS IS ABOUT LATENCY, NOT CPU. One `statSync` is 1392ns, so even a
   * flat 150ms poll is 0.033 seconds of CPU per hour — free either way.
   *
   * ⚠️ AN EARLIER VERSION OF THIS COMMENT CITED THAT CPU FIGURE AS THE
   * REASON, which claude1 pointed out measures the wrong thing: the cost of
   * a poll is TIMER WAKEUPS, not cycles. A laptop that never idles its CPU
   * is the argument against a fast flat poll, and `0.0125 s/hour` says
   * nothing about it.
   *
   * So what backoff buys is permission to be FAST when it matters.
   * Conversation is bursty: a reply usually follows within seconds, so
   * 150ms during a burst is a real improvement, and relaxing to 2s while
   * nobody is talking costs nothing anyone can feel.
   */
  static readonly MIN_POLL_MS = 150;
  static readonly MAX_POLL_MS = 2000;

  /** How fast it relaxes. 1.5 reaches the ceiling in ~7 idle ticks. */
  static readonly BACKOFF = 1.5;

  constructor(handle: string) {
    ensureNotifyDir();
    this.path = notifyPathFor(handle);

    try {
      writeFileSync(this.path, '', { flag: 'a' });
    } catch {
      // Best-effort; subsequent touch() calls will create it
    }

    this.seen = this.stamp();
    this.interval = NotifyBus.MIN_POLL_MS;

    // 🛑 A POLL, NOT chokidar. lee, 2026-10-31: *"I just don't want file
    // watchers"*. The watch is also the mechanism measured on #33 at 8 of 10
    // signals LOST — ten writes to this file produced two events, because
    // the file overwrites and the watcher coalesces.
    //
    // ⚠️ POLLING COALESCES TOO, and that is harmless HERE for a reason worth
    // stating: every subscriber re-reads the bus from SQLite on any signal,
    // so a merged signal costs latency and never a message. SQLite is the
    // truth; this file is only a doorbell.
    this.timer = this.arm();
  }

  /**
   * One tick, then re-arm at the next interval.
   *
   * ⚠️ `setTimeout` RATHER THAN `setInterval`, because the interval changes.
   * A `setInterval` would have to be cleared and recreated anyway, and a
   * missed clear leaves two timers polling the same file forever.
   */
  private arm(): NodeJS.Timeout {
    const timer = setTimeout(() => {
      if (this.closed) return;

      const now = this.stamp();

      if (now === this.seen) {
        this.interval = Math.min(
          Math.round(this.interval * NotifyBus.BACKOFF),
          NotifyBus.MAX_POLL_MS,
        );
      } else {
        this.seen = now;
        // Activity means more is likely. Drop straight to the floor rather
        // than easing down, because a burst is exactly when latency shows.
        this.interval = NotifyBus.MIN_POLL_MS;
        this.fire();
      }

      this.timer = this.arm();
    }, this.interval);

    // Never hold a process open for the doorbell alone.
    timer.unref();

    return timer;
  }

  /** The current gap between checks. Exposed so the behaviour is testable. */
  get pollIntervalMs(): number {
    return this.interval;
  }

  /** mtime plus size — a rewrite of identical length still changes mtime. */
  private stamp(): string {
    try {
      const s = statSync(this.path);

      return `${s.mtimeMs}:${s.size}`;
    } catch {
      return 'missing';
    }
  }

  private fire(): void {
    for (const cb of this.subs) {
      try {
        cb();
      } catch {
        // Subscribers must not throw; swallow to keep the bus alive
      }
    }
  }

  /**
   * Write an event to this peer's own notify file. Rarely useful directly —
   * senders should call `notifyPeer(recipientHandle, envelope)` to signal a
   * message. Kept for symmetry / future presence pings.
   */
  touch(envelope?: NotifyEnvelope): void {
    const payload = envelope ? JSON.stringify(envelope) : String(Date.now());
    writeFileSync(this.path, payload);
  }

  subscribe(cb: Callback): () => void {
    this.subs.add(cb);
    return () => {
      this.subs.delete(cb);
    };
  }

  waitForNext(timeoutMs: number): Promise<'notified' | 'timeout'> {
    return new Promise((resolve) => {
      let done = false;
      const finish = (result: 'notified' | 'timeout'): void => {
        if (done) return;
        done = true;
        unsubscribe();
        clearTimeout(timer);
        resolve(result);
      };
      const unsubscribe = this.subscribe(() => finish('notified'));
      const timer = setTimeout(() => finish('timeout'), timeoutMs);
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.subs.clear();
    clearTimeout(this.timer);
    // Clean up our own notify file on shutdown so a stale entry doesn't
    // linger for the next boot.
    try {
      if (existsSync(this.path)) unlinkSync(this.path);
    } catch {
      // Best-effort — the file may already be gone
    }
  }
}
