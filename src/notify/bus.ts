import chokidar, { type FSWatcher } from 'chokidar';
import { writeFileSync } from 'node:fs';
import { ensureStateDir, notifyPath } from '../util/paths.js';

type Callback = () => void;

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

  touch(): void {
    // Overwrite with a monotonic marker so mtime + size both change
    writeFileSync(this.path, String(Date.now()));
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
