import { resolve } from 'node:path';
import { realpathSync } from 'node:fs';

/**
 * What a supervised agent may do without asking.
 *
 * 🛑 DECIDED by lee 2026-10-31: *"allowlist, start narrow — read files, run
 * tests, git commit"*, then *"yes, it needs Write and Edit in the allow list"*,
 * then *"those could be pre-approved"* of the directory scopes.
 *
 * Anything not here is denied, relayed to lee, and re-dispatched on approval.
 * See `redispatch.ts` — the re-dispatch prompt is the load-bearing part.
 */

/**
 * Where a supervised agent may work, by default.
 *
 * 🛑 THE LAUNCH DIRECTORY, NOT A HARDCODED LIST. An earlier version named
 * three of claude2's own trees as constants, which is wrong for a tool two
 * agents share: claude1's supervisor starts in `~/dev/leagues` and would
 * have been REFUSED by a list that never mentioned it. lee, 2026-10-31:
 * *"in the new harness, claude1 would have been started in /leagues anyway"*.
 *
 * The operator chooses by launching somewhere, and widens with `--add-dir`.
 */
export function defaultDirs(launchCwd: string = process.cwd()): string[] {
  return [launchCwd];
}

/**
 * The allowlist rules for a set of directories. BOTH are required.
 *
 * 🛑 NEITHER ALONE CONTAINS THE AGENT, and that cost two wrong conclusions.
 * Measured 2026-10-31 with the cwd held constant:
 *
 *   bare `Write`,`Edit`          -> edited /tmp. ANY path.
 *   `Edit(<glob>)` + --add-dir   -> edited the allowed dir, DENIED /tmp
 *   `Edit(<glob>)` alone         -> DENIED the allowed dir too
 *
 * The rules say WHICH PATHS. The directories make those paths reachable.
 */
export function editScopesFor(dirs: readonly string[]): string[] {
  return dirs.map((dir) => `Edit(${dir}/**)`);
}

export const DEFAULT_CWD_NOTE =
  'the supervisor is launched in the directory its child should work in';

/**
 * Refuse a working directory outside the reachable set.
 *
 * Returns the REAL directory to use. Throws rather than falling back, because
 * a silent correction would put the child somewhere the operator did not ask
 * for and did not notice.
 *
 * 🛑 `realpathSync`, NOT `resolve`. `resolve` is LEXICAL and a symlink inside
 * an allowed directory escapes it. Measured:
 *
 *   ln -s /etc ~/playground/evil-link
 *   resolveCwd('~/playground/evil-link') -> ACCEPTED, real location /private/etc
 *
 * Found by claude1. Reachable in two steps rather than one: the child may run
 * `Bash(npm test:*)` and may edit `~/playground/package.json`.
 *
 * ⚠️ A MISSING DIRECTORY MUST NOT READ AS A CONTAINMENT REFUSAL. `realpathSync`
 * throws ENOENT, and reporting that as "outside the allowed directories" would
 * send the operator hunting for a permissions problem that does not exist.
 */
export function resolveCwd(
  requested: string | undefined,
  dirs: readonly string[],
): string {
  // 🛑 THE DEFAULT GOES THROUGH THE SAME CHECK. It used to be returned
  // unvalidated, so `resolveCwd(undefined, [])` succeeded while
  // `resolveCwd(EXTRA_DIRS[0], [])` threw — the predicate did not govern its
  // own default. Raised by claude1.
  const target = requested ?? dirs[0];

  if (target === undefined) {
    throw new Error('a supervised child needs at least one allowed directory');
  }

  let real: string;
  try {
    real = realpathSync(resolve(target));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`working directory does not exist: ${target}`);
    }

    throw err;
  }

  const ok = dirs.some((dir) => {
    let base: string;
    try {
      base = realpathSync(resolve(dir));
    } catch {
      // An allowed directory that is not on disk cannot contain anything.
      return false;
    }

    return real === base || real.startsWith(`${base}/`);
  });

  if (!ok) {
    throw new Error(
      `refusing to run a supervised child in "${target}": a child's working directory is ` +
        `always reachable, and this resolves to "${real}", which is outside every allowed ` +
        `directory (${dirs.join(', ')})`,
    );
  }

  return real;
}

/**
 * The narrow starting set.
 *
 * ⚠️ IT DOES NOT CONTAIN BASH, and that is a property of allowlists rather
 * than of this list. `Bash(npm test:*)` runs whatever `package.json` says,
 * and `git commit` runs hooks. A tool allowlist scopes WHAT, never WHERE.
 */
export function allowlistFor(dirs: readonly string[]): string[] {
  return [
  'Read',
  'Glob',
  'Grep',

  // 🛑 SCOPED, NEVER BARE, AND THIS WAS PROVEN THE EXPENSIVE WAY.
  //
  // A bare `Write` or `Edit` allows the tool against ANY path — measured, it
  // edited `/tmp` with `--add-dir` naming three unrelated directories. The
  // directory list does not constrain a bare entry at all.
  //
  // ⚠️ IT ALSO COMPOUNDED WITH THE PERMISSION MODE: `acceptEdits` was
  // justified by a comment claiming no Edit tool existed to accept, which
  // stopped being true the moment Write and Edit were added. Found by
  // claude1; I then "fixed" it by going bare and reopened the hole.
  //
  // These cover Write too — the CLI states `Edit(path)` rules govern every
  // file-editing tool.
  ...editScopesFor(dirs),

  // Inspect and record work, but never publish it.
  'Bash(git status:*)',
  'Bash(git diff:*)',
  'Bash(git add:*)',
  'Bash(git commit:*)',

  // Prove it before claiming it.
  'Bash(npm test:*)',
  'Bash(npx playwright:*)',
  'Bash(php artisan test:*)',

  // Answer on the bus. Without these the supervisor is a doorbell.
  'mcp__chat__send',
  'mcp__chat__room_send',
  'mcp__chat__inbox',
  'mcp__chat__room_inbox',
  ];
}

/**
 * The allowlist plus a grant lee has just approved.
 *
 * 🛑 ADDITIVE. A grant that replaced the list would silently revoke everything
 * the agent already had, mid-task, and the symptom would be a second denial
 * for something that worked a minute earlier.
 */
export function allowlistWith(base: readonly string[], granted: readonly string[]): string[] {
  return [...new Set([...base, ...granted])];
}

/**
 * The built-in tools that EXIST for a supervised child. Feeds `--tools`.
 *
 * 🛑 DELIBERATELY WIDER THAN THE ALLOWLIST IMPLIES, AND THE GAP IS THE DESIGN.
 * `Write` and `Edit` must EXIST or a scoped `Edit(<glob>)` rule has nothing to
 * permit — but neither is allowlisted bare, so they are usable only inside
 * the three directories above.
 *
 * ⚠️ So `builtinsFrom(DEFAULT_ALLOWLIST)` is a strict SUBSET of this, not an
 * equal. A test asserting equality would force one of the two bugs back.
 */
export const AVAILABLE_BUILTINS = ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash'] as const;
