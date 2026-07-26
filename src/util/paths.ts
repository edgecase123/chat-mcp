import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

export function stateDir(): string {
  const override = process.env.CHAT_MCP_HOME;
  if (override && override.length > 0) return override;
  return join(homedir(), '.chat-mcp');
}

export function dbPath(): string {
  return join(stateDir(), 'chat.db');
}

export function notifyPath(): string {
  return join(stateDir(), 'notify');
}

export function ensureStateDir(): string {
  const dir = stateDir();
  mkdirSync(dir, { recursive: true });
  return dir;
}
