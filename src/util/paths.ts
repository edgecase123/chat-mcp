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
