import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, chmodSync, existsSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import type { Stats } from 'node:fs';

/**
 * 🛑 UNDER THE TEST RUNNER, THE DEFAULT PATH IS REFUSED. Ruled by lee.
 *
 * `WakeListener.bind()` unlinks a socket it probes as stale, and a live
 * supervisor merely slow to answer looks the same as debris. Two test files
 * resolved this path and left 3582 files in the operator's real `~/.chat-mcp`.
 *
 * `node --test` sets `NODE_TEST_CONTEXT` and nothing else does, so the refusal
 * reaches every test while a real invocation keeps the default. It throws
 * rather than warning, because a warning still leaves the socket unlinked.
 *
 * ⚠️ A CHILD INHERITS THE VARIABLE, so it refuses too. That is correct — a child
 * spawned from a test writes to the live directory exactly as its parent would —
 * but it has no import to come before, which is why the message addresses both.
 */
export function stateDir(): string {
  const override = process.env.CHAT_MCP_HOME;
  if (override && override.length > 0) return override;

  if (process.env.NODE_TEST_CONTEXT !== undefined) {
    throw new Error(
      'CHAT_MCP_HOME is unset under the node test runner, so this would resolve the ' +
        "operator's live ~/.chat-mcp — where binding a socket unlinks whatever looks " +
        'stale, silently stopping a running agent.\n' +
        'In a TEST: set process.env.CHAT_MCP_HOME to a temp directory BEFORE importing ' +
        'anything that resolves a state path.\n' +
        'In a SPAWNED CHILD, which inherits NODE_TEST_CONTEXT and so lands here with no ' +
        'import of its own: pass it through, ' +
        'spawn(cmd, { env: { ...process.env, CHAT_MCP_HOME: dir } }).',
    );
  }

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
  mkdirSync(dir, { recursive: true, mode: STATE_DIR_MODE });
  chmodVerified(dir, STATE_DIR_MODE);

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

/** Owner-only, so no other local account may traverse into the state dir. */
export const STATE_DIR_MODE = 0o700;

/** Owner-only read+write, for every file the bus stores under that dir. */
export const STATE_FILE_MODE = 0o600;

/**
 * 🛑 A chmod CAN SUCCEED AND CHANGE NOTHING, so read the mode back.
 *
 * On WSL a `CHAT_MCP_HOME` under `/mnt/c` sits on DrvFs, which carries no
 * POSIX mode unless the mount says `metadata`. `chmodSync` there returns
 * success. Without this read-back the whole fix reports green while every
 * message stays readable.
 *
 * win32 is exempt because modes are not enforceable there at all — its
 * protection is the ACL inherited from the user profile directory.
 */
export function chmodVerified(path: string, mode: number, stat: (p: string) => Stats = statSync) {
  chmodSync(path, mode);
  if (process.platform === 'win32') return;

  const got = stat(path).mode & 0o777;
  if (got === mode) return;

  throw new Error(
    `chmod on ${path} did not take: asked for ${mode.toString(8)}, got ${got.toString(8)}. ` +
      'A filesystem that ignores modes cannot hold this. Move CHAT_MCP_HOME onto one that can, ' +
      'or mount it with POSIX metadata.',
  );
}

/** Write a file nobody else on the host may read. */
export function writePrivateFileSync(path: string, data: string, flag?: string) {
  writeFileSync(path, data, flag ? { mode: STATE_FILE_MODE, flag } : { mode: STATE_FILE_MODE });
  // 🛑 The `mode` above applies on CREATE only, and is masked by the umask.
  // Every file that predates this guard needs the explicit chmod.
  chmodSync(path, STATE_FILE_MODE);
}

/**
 * 🛑 THE DIRECTORY MODE IS THE WHOLE FIX. Every per-file mode below is a
 * second layer.
 *
 * It is the only control that reaches files no code path will ever chmod:
 * the SQLite WAL and shm, a stale `chat.db.bak-*`, anything a future feature
 * drops in here. Denying traversal covers them without naming them.
 */
/**
 * 🛑 THE DIRECTORY IS THE CONTROL, WHICH IS WHY THE SCRIPTS MAY STAY 0755.
 *
 * Both framework installers created this with a bare `mkdirSync`, so it was
 * born at the launching shell's umask. Extracted here so the mode has one
 * home instead of one per installer.
 */
export function ensureAdaptersDir(): string {
  ensureStateDir();
  const dir = adaptersDir();
  mkdirSync(dir, { recursive: true, mode: STATE_DIR_MODE });
  chmodVerified(dir, STATE_DIR_MODE);

  return dir;
}

export function ensureStateDir(): string {
  const dir = stateDir();
  mkdirSync(dir, { recursive: true, mode: STATE_DIR_MODE });
  chmodVerified(dir, STATE_DIR_MODE);

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
  mkdirSync(dir, { recursive: true, mode: STATE_DIR_MODE });
  chmodVerified(dir, STATE_DIR_MODE);

  return dir;
}
