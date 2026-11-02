import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, chmodSync, existsSync, statSync, unlinkSync } from 'node:fs';

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

/**
 * 🛑 0700, AND THE chmod IS NOT REDUNDANT WITH THE mkdir MODE.
 *
 * `mkdir`'s mode is masked by the process umask, and an ALREADY EXISTING
 * directory keeps whatever mode it was created with. Both paths left this at
 * the umask's mercy: 755 under the usual 022, 777 under 000.
 *
 * Connecting to a unix socket needs the write bit, so until now the only
 * thing keeping another local account off a supervisor's socket was the
 * launching shell's umask. That is the environment doing the work, and
 * nothing tested it.
 *
 * 🛑 THE DIRECTORY IS WHAT CLOSES THE RACE, not the socket's own mode.
 * `listen()` creates the socket file at the umask mode and `chmod` can only
 * follow it, so there is a window. A 0700 directory denies traversal for the
 * whole of that window.
 */
export function ensureSocketDir(): string {
  ensureStateDir();
  const dir = socketDir();
  mkdirSync(dir, { recursive: true, mode: SOCKET_DIR_MODE });
  chmodSync(dir, SOCKET_DIR_MODE);

  return dir;
}

/** Owner-only, so no other local account may traverse into the socket dir. */
export const SOCKET_DIR_MODE = 0o700;

/** Owner-only read+write. A unix socket needs the write bit to connect. */
export const SOCKET_MODE = 0o600;

/**
 * Where a supervisor writes the private MCP config for its child.
 *
 * 🛑 NOT the consuming project's `.mcp.json`. That file hardcodes a handle a
 * live session already owns, and `--strict-mcp-config` exists precisely to
 * exclude it. Writing there would also mutate somebody else's repo.
 */
export function mcpConfigDir(): string {
  return join(stateDir(), 'mcp');
}

export function mcpConfigPathFor(handle: string): string {
  return join(mcpConfigDir(), `${handle}.json`);
}

export function ensureMcpConfigDir(): string {
  ensureStateDir();
  const dir = mcpConfigDir();
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
