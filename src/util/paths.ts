import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, existsSync, statSync, unlinkSync } from 'node:fs';

export function stateDir(): string {
  const override = process.env.CHAT_MCP_HOME;
  if (override && override.length > 0) return override;
  return join(homedir(), '.chat-mcp');
}

export function dbPath(): string {
  return join(stateDir(), 'chat.db');
}

export function notifyDir(): string {
  return join(stateDir(), 'notify');
}

export function notifyPathFor(handle: string): string {
  return join(notifyDir(), handle);
}

/**
 * Where a supervisor listens for direct delivery.
 *
 * 🛑 Kept SHORT on purpose. A unix domain socket path is capped at ~104 bytes
 * on macOS and ~108 on Linux, and the failure is a truncated bind rather than
 * a clear error. `~/.chat-mcp/sock/<handle>` leaves room for long handles.
 */
export function socketDir(): string {
  return join(stateDir(), 'sock');
}

export function socketPathFor(handle: string): string {
  return join(socketDir(), handle);
}

export function ensureSocketDir(): string {
  ensureStateDir();
  const dir = socketDir();
  mkdirSync(dir, { recursive: true });

  return dir;
}

export function adaptersDir(): string {
  return join(stateDir(), 'adapters');
}

/**
 * Canonical path for a wake-adapter script. Shared by the installer (which
 * writes it) and the shim's boot check (which tests its presence) so a
 * rename doesn't silently desync the two sides.
 */
export function adapterScriptPath(framework: string, handle: string): string {
  return join(adaptersDir(), `${framework}-${handle}.sh`);
}

export function ensureStateDir(): string {
  const dir = stateDir();
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function ensureNotifyDir(): string {
  ensureStateDir();
  const dir = notifyDir();
  // Migration: pre-0.0.2 releases used ~/.chat-mcp/notify as a single shared
  // file. Per-agent files require it to be a directory. Delete the stale file
  // once so mkdir can succeed.
  if (existsSync(dir) && statSync(dir).isFile()) {
    unlinkSync(dir);
  }
  mkdirSync(dir, { recursive: true });
  return dir;
}
