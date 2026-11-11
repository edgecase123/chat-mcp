import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';

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
 * The absolute path a manifest's script actually runs, or throw.
 *
 * ⚠️ MISSING AND OUTSIDE ARE DIFFERENT ERRORS. Reporting a typo'd script as a
 * containment refusal sends the operator hunting a permissions problem that
 * does not exist — the same distinction `resolveCwd` makes.
 */
export function checkedScriptPath(projectDir: string, script: UncheckedScript): string {
  const target = join(projectDir, script.relative);
  let real: string;

  try {
    real = realpathSync(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`command script does not exist: ${target}`);
    }

    throw err;
  }

  if (!realContains(projectDir, real)) {
    throw new Error(
      `refusing to run "${script.relative}": it resolves to "${real}", which is outside ` +
        `the project directory "${projectDir}"`,
    );
  }

  return real;
}
