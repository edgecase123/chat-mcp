import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "../util/paths.js";

export const DEFAULT_MAX_CONCURRENT = 4;
export const DEFAULT_TIMEOUT_MINUTES = 15;
export const DEFAULT_MAX_BUFFER_MB = 8;

export const DEFAULT_TIMEOUT_MS = DEFAULT_TIMEOUT_MINUTES * 60 * 1000;
export const DEFAULT_MAX_BUFFER = DEFAULT_MAX_BUFFER_MB * 1024 * 1024;

/**
 * 🛑 A CEILING PER KEY, BECAUSE VALIDATING THE INPUT DOES NOT BOUND THE
 * PRODUCT. `1e305` is finite and `1e305 * 60 * 1000` is `Infinity`, which is
 * no timeout at all — the bound this file exists to make configurable.
 *
 * Each one is already past any value with a use: more than 64 host processes
 * per handle is not throttling, a day is not a timeout, and a gigabyte of
 * output is not a buffer.
 */
export const MAX_CONCURRENT_CEILING = 64;
export const MAX_TIMEOUT_MINUTES = 24 * 60;
export const MAX_BUFFER_MB_CEILING = 1024;

const KEYS = ["maxConcurrent", "timeoutMinutes", "maxBufferMb"] as const;

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
  return join(stateDir(), "limits.json");
}

const quoted = (keys: readonly string[]) =>
  keys.map((k) => `"${k}"`).join(", ");

/**
 * 🛑 AN UNKNOWN KEY IS REFUSED, NOT IGNORED. A misspelling is the one bad input
 * that still parses, so ignoring it leaves the operator's tightened value
 * unapplied while the file reads correct at a glance.
 */
function assertKnownKeys(raw: Record<string, unknown>, path: string): void {
  const unknown = Object.keys(raw).filter(
    (k) => !(KEYS as readonly string[]).includes(k),
  );

  if (unknown.length === 0) return;

  throw new Error(
    `${path} has ${unknown.length === 1 ? "an unknown key" : "unknown keys"} ` +
      `${quoted(unknown)}; the limits are ${quoted(KEYS)}`,
  );
}

/**
 * 🛑 THE FINITE CHECK COMES BEFORE ANY CLAMP. `Math.max(1, NaN)` is `NaN`, and
 * every comparison against `NaN` is false, so a junk value reaching the clamp
 * would REMOVE the cap rather than default it.
 */
function finite(value: unknown, key: string, path: string): number | undefined {
  if (value === undefined) return undefined;

  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`"${key}" in ${path} is not a finite number`);
  }

  return value;
}

/** Refuses above `max`; a caller decides what a value below 1 means. */
function atMost(
  value: unknown,
  key: string,
  path: string,
  max: number,
): number | undefined {
  const n = finite(value, key, path);

  if (n === undefined) return undefined;

  if (n > max) throw new Error(`"${key}" in ${path} must be at most ${max}`);

  return n;
}

/**
 * For the two limits with no most-restrictive-but-usable value. A zero timeout
 * kills every command, so clamping would have to invent a floor.
 */
function positive(
  value: unknown,
  key: string,
  path: string,
  max: number,
): number | undefined {
  const n = atMost(value, key, path, max);

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
 * ⚠️ THE MESSAGE NAMES THE PATH, SO IT IS NOT FIT TO BE PUBLIC. The caller
 * wraps it in a `Refusal` with a fixed sentence and lets this ride in `detail`.
 *
 * A missing file is not an error — it is the normal case.
 */
export function commandLimits(path: string = limitsPath()): CommandLimits {
  if (!existsSync(path)) return DEFAULTS;

  let parsed: unknown;

  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(
      `${path} is not readable JSON, so the command limits it sets cannot be applied: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path} must hold a JSON object`);
  }

  const raw = parsed as Record<string, unknown>;

  assertKnownKeys(raw, path);

  // A cap below 1 is read as 1, the same meaning `RunCommandOptions` already
  // gives it. An operator writing 0 wants throttling, never a deadlock.
  const maxConcurrent = Math.max(
    1,
    atMost(raw.maxConcurrent, "maxConcurrent", path, MAX_CONCURRENT_CEILING) ??
      DEFAULT_MAX_CONCURRENT,
  );

  const minutes =
    positive(raw.timeoutMinutes, "timeoutMinutes", path, MAX_TIMEOUT_MINUTES) ??
    DEFAULT_TIMEOUT_MINUTES;

  const mb =
    positive(raw.maxBufferMb, "maxBufferMb", path, MAX_BUFFER_MB_CEILING) ??
    DEFAULT_MAX_BUFFER_MB;

  return {
    maxConcurrent,
    timeoutMs: minutes * 60 * 1000,
    maxBuffer: mb * 1024 * 1024,
  };
}
