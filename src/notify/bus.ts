import chokidar, { type FSWatcher } from 'chokidar';
import { writeFileSync } from 'node:fs';
import { ensureStateDir, notifyPath } from '../util/paths.js';

type Callback = () => void;

export interface NotifyEnvelope {
  id: number;
  to: string;
  from: string;
  ts: number;
}

export class NotifyBus {
  private readonly subs = new Set<Callback>();
  private readonly watcher: FSWatcher;
  private readonly path: string;

  constructor() {
    ensureStateDir();
    this.path = notifyPath();
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

  touch(envelope?: NotifyEnvelope): void {
    // External watchers read this file to learn what changed. When an envelope
    // is provided (a new message landed) we write a single-line JSON object
    // carrying recipient + message id + sender, so a watcher can filter to its
    // own handle without touching SQLite. Without an envelope we fall back to
    // a bare timestamp — enough to fire mtime-based watchers for events that
    // don't correspond to a specific message (future presence pings, etc.).
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
  }
}
