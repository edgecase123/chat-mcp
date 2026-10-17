import chokidar, { type FSWatcher } from 'chokidar';
import { writeFileSync, existsSync, unlinkSync } from 'node:fs';
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
  private readonly watcher: FSWatcher;
  private readonly path: string;

  constructor(handle: string) {
    ensureNotifyDir();
    this.path = notifyPathFor(handle);
    // Ensure the file exists so chokidar has something to watch on add
    try {
      writeFileSync(this.path, '', { flag: 'a' });
    } catch {
      // Best-effort; subsequent touch() calls will create it
    }
    this.watcher = chokidar.watch(this.path, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: false,
      atomic: false,
    });
    const fire = (): void => this.fire();
    this.watcher.on('change', fire);
    this.watcher.on('add', fire);
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
    this.subs.clear();
    await this.watcher.close();
    // Clean up our own notify file on shutdown so a stale entry doesn't
    // linger for the next boot.
    try {
      if (existsSync(this.path)) unlinkSync(this.path);
    } catch {
      // Best-effort — the file may already be gone
    }
  }
}
