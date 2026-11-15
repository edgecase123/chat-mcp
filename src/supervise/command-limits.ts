import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir } from '../util/paths.js';

export const DEFAULT_MAX_CONCURRENT = 4;
export const DEFAULT_TIMEOUT_MINUTES = 15;
export const DEFAULT_MAX_BUFFER_MB = 8;

export const DEFAULT_TIMEOUT_MS = DEFAULT_TIMEOUT_MINUTES * 60 * 1000;
export const DEFAULT_MAX_BUFFER = DEFAULT_MAX_BUFFER_MB * 1024 * 1024;

export interface CommandLimits {
  readonly maxConcurrent: number;
  readonly timeoutMs: number;
  readonly maxBuffer: number;
}

const DEFAULTS: CommandLimits = {
  maxConcurrent: DEFAULT_MAX_CONCURRENT,
  timeoutMs: DEFAULT_TIMEOUT_MS,
  maxBuffer: DEFAULT_MAX_BUFFER,
};

/**
 * 🛑 INSIDE `stateDir()`, WHICH IS BIND-MOUNTED INTO NO CONTAINER.
 * `assertProjectDirOutsideState` already asserts a project tree is disjoint
 * from `stateDir()`, so a file here cannot fall inside a mounted tree. A third
 * `assertDisjoint` for this path would be dead code.
 */
export function limitsPath(): string {
  return join(stateDir(), 'limits.json');
}

/**
 * 🛑 THE FINITE CHECK COMES BEFORE ANY CLAMP. `Math.max(1, NaN)` is `NaN`, and
 * every comparison against `NaN` is false, so a junk value reaching the clamp
 * would REMOVE the cap rather than default it.
 */
function finite(value: unknown, key: string, path: string): number | undefined {
  if (value === undefined) return undefined;

  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`"${key}" in ${path} is not a finite number`);
  }

  return value;
}

/**
 * For the two limits with no most-restrictive-but-usable value. A zero timeout
 * kills every command, so clamping would have to invent a floor.
 */
function positive(value: unknown, key: string, path: string): number | undefined {
  const n = finite(value, key, path);

  if (n === undefined) return undefined;

  if (n <= 0) throw new Error(`"${key}" in ${path} must be greater than zero`);

  return n;
}

/**
 * The three limits on a project command, from `limits.json`.
 *
 * 🛑 AN UNREADABLE FILE THROWS. Falling back to the defaults would hand back
 * the PERMISSIVE value while the operator's tightened one sat in the file
 * looking applied, and the concurrency cap is a security limit.
 *
 * A missing file is not an error — it is the normal case.
 */
export function commandLimits(path: string = limitsPath()): CommandLimits {
  if (!existsSync(path)) return DEFAULTS;

  let parsed: unknown;

  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(
      `${path} is not readable JSON, so the command limits it sets cannot be applied: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${path} must hold a JSON object`);
  }

  const raw = parsed as Record<string, unknown>;

  // A cap below 1 is read as 1, the same meaning `RunCommandOptions` already
  // gives it. An operator writing 0 wants throttling, never a deadlock.
  const maxConcurrent = Math.max(
    1,
    finite(raw.maxConcurrent, 'maxConcurrent', path) ?? DEFAULT_MAX_CONCURRENT,
  );

  const minutes = positive(raw.timeoutMinutes, 'timeoutMinutes', path) ?? DEFAULT_TIMEOUT_MINUTES;
  const mb = positive(raw.maxBufferMb, 'maxBufferMb', path) ?? DEFAULT_MAX_BUFFER_MB;

  return { maxConcurrent, timeoutMs: minutes * 60 * 1000, maxBuffer: mb * 1024 * 1024 };
}
