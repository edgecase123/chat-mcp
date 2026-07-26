import chokidar, { type FSWatcher } from 'chokidar';
import { writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { ensureNotifyDir, notifyPathFor } from '../util/paths.js';

type Callback = () => void;

export interface NotifyEnvelope {
  id: number;
  to: string;
  from: string;
  ts: number;
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
