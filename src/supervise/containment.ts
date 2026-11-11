import { realpathSync } from 'node:fs';
import { isAbsolute, join, normalize, resolve } from 'node:path';

/**
 * Is a path inside a directory, after symlinks?
 *
 * 🛑 `realpathSync`, NOT `resolve`. `resolve` is LEXICAL and a symlink inside
 * an allowed directory escapes it. Measured by claude1 on the working-directory
 * path, and again on a manifest script path:
 *
 *   ln -s /bin/sh proj/scripts/go.sh
 *   a lexical check reads "scripts/go.sh" as contained; it runs /bin/sh
 */

/**
 * A manifest script path that has been checked LEXICALLY and nothing more.
 *
 * 🛑 NOT A STRING, DELIBERATELY. The lexical check cannot see a symlink, so
 * the only safe use is `checkedScriptPath`. Making this an object means
 * handing it to `execFile` is a compile error rather than a missing call.
 */
export interface UncheckedScript {
  /** Relative to the project directory, normalised, lexically contained. */
  readonly relative: string;
}

/**
 * Does `dir` contain `target`, comparing REAL paths?
 *
 * A `dir` that is not on disk contains nothing — an absent allowed directory
 * must not accidentally contain everything.
 */
export function realContains(dir: string, target: string): boolean {
  let base: string;
  let real: string;

  try {
    base = realpathSync(resolve(dir));
  } catch {
    return false;
  }

  try {
    real = realpathSync(resolve(target));
  } catch {
    // Compare what the caller named. A missing target is not contained, and
    // the caller distinguishes "missing" from "outside" by its own check.
    real = resolve(target);
  }

  return real === base || real.startsWith(`${base}/`);
}

/**
 * Refuse a relative path that is absolute, control-charactered, or that
 * LEXICALLY leaves the project. Returns the normalised form.
 *
 * 🛑 LEXICAL ONLY, SO IT IS NOT CONTAINMENT. It exists for the one caller that
 * has no project directory to resolve against — manifest PARSE time, where
 * there is no file on disk either. Anything that then acts on the path goes
 * through `checkedProjectPath`.
 */
export function containedRelative(raw: unknown, noun: string): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error(`${noun} must be a non-empty string`);
  }

  if (isAbsolute(raw)) {
    throw new Error(`${noun} must be a relative path, got "${raw}"`);
  }

  // 🛑 BEFORE normalize(). A NUL makes `scripts/gate.sh\0../../bin/sh`
  // normalise to the innocent-looking `scripts/bin/sh`, and a newline or a
  // control character only surfaces as an ERR_INVALID_ARG_VALUE at spawn time.
  if (/[\u0000-\u001f\u007f]/.test(raw)) {
    throw new Error(`${noun} has a control character in it: "${raw}"`);
  }

  const normalised = normalize(raw);
  // 🛑 SEGMENTS, NOT `startsWith('../')`. On win32 `normalize` returns
  // `..\bin\sh`, which a forward-slash prefix check reads as contained. A
  // filename that merely BEGINS with dots, like `..foo`, is legitimate.
  const segments = normalised.split(/[\\/]/);

  if (segments[0] === '..') {
    throw new Error(`${noun} must stay inside the project, got "${raw}"`);
  }

  if (segments.some((segment) => segment.startsWith('-'))) {
    throw new Error(`${noun} must not have a path segment starting with "-", got "${raw}"`);
  }

  return normalised;
}

/**
 * The absolute path a project-relative entry actually resolves to, or throw.
 *
 * ⚠️ MISSING AND OUTSIDE ARE DIFFERENT ERRORS. Reporting a typo'd path as a
 * containment refusal sends the operator hunting a permissions problem that
 * does not exist — the same distinction `resolveCwd` makes. `noun` is what the
 * caller is checking, so neither message is script-specific.
 */
export function checkedProjectPath(projectDir: string, relative: string, noun: string): string {
  const target = join(projectDir, containedRelative(relative, noun));
  let real: string;

  try {
    real = realpathSync(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`${noun} does not exist: ${target}`);
    }

    throw err;
  }

  if (!realContains(projectDir, real)) {
    throw new Error(
      `refusing "${relative}": it resolves to "${real}", which is outside ` +
        `the project directory "${projectDir}"`,
    );
  }

  return real;
}

/** The absolute path a manifest's script actually runs, or throw. */
export function checkedScriptPath(projectDir: string, script: UncheckedScript): string {
  return checkedProjectPath(projectDir, script.relative, 'command script');
}
