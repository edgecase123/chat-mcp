import { resolve } from 'node:path';

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
 * Directories a supervised agent may touch, beyond its working directory.
 *
 * 🛑 THESE FEED `--add-dir`, NOT THE ALLOWLIST, AND THAT CORRECTION COST A
 * MEASUREMENT. They were `Edit(<glob>)` entries in `--allowedTools`, which
 * looked like path scoping and is not: Claude Code confines file writes to
 * the WORKING DIRECTORY, and an allowlist glob outside it grants nothing.
 *
 * Measured 2026-10-31, same file, same allowlist, only the cwd differing:
 *
 *   cwd = chat-mcp2, Edit(/…/playground/**) allowlisted  -> DENIED
 *       "path is outside the allowed working directories"
 *   cwd = playground                                     -> EDITED
 *
 * ⚠️ SO THE OLD SCOPES PROMISED ACCESS THEY COULD NOT GIVE. The containment
 * was real and came from somewhere else. claude1 called the claim a
 * hypothesis; the positive control is what exposed it.
 *
 * ⚠️ AND THE FIRST ATTEMPT TO MEASURE IT WAS VACUOUS — the run died on a
 * missing MCP config, the file was unchanged, and that nearly read as
 * "contained". A run that never started proves nothing.
 */
export const EXTRA_DIRS = [
  '/Users/leejenkins/dev/leagues2',
  '/Users/leejenkins/dev/chat-mcp2',
  '/Users/leejenkins/playground',
] as const;

/**
 * The same directories as allowlist rules. BOTH are required.
 *
 * 🛑 NEITHER ALONE CONTAINS THE AGENT, and that cost two wrong conclusions.
 * Measured 2026-10-31 with the cwd held constant at `~/dev/chat-mcp2`:
 *
 *   bare `Write`,`Edit`            -> edited /tmp. ANY path. add-dir irrelevant.
 *   `Edit(<glob>)` + --add-dir     -> edited ~/playground, DENIED /tmp
 *
 * ⚠️ AN EARLIER READING BLAMED THE CWD ALONE. It compared two runs differing
 * in TWO variables — the cwd and the allowlist — and attributed the whole
 * effect to the first. claude1 called it a hypothesis and was right.
 *
 * The rules say WHICH PATHS. `EXTRA_DIRS` makes those paths reachable at all.
 */
export const EDIT_SCOPES = EXTRA_DIRS.map((dir) => `Edit(${dir}/**)`);

/**
 * The working directory a supervised child runs in.
 *
 * 🛑 THE CWD IS A THIRD CONTAINMENT INPUT AND IT HAD NO DEFAULT. A child's
 * working directory is reachable BY DEFINITION, so an unset one silently
 * inherits wherever the operator happened to launch the supervisor — from
 * `~/dev/leagues` that is the sibling agent's live tree. Found by claude1.
 *
 * ⚠️ NO MEASUREMENT COULD SETTLE IT CHEAPLY, because every run so far held
 * the cwd at a directory that is already in EXTRA_DIRS. That is the same
 * two-variable confound that produced the previous wrong conclusion. A
 * default plus a refusal removes the question instead of answering it.
 */
export const DEFAULT_CWD = EXTRA_DIRS[0];

/**
 * Refuse a working directory outside the reachable set.
 *
 * Returns the directory to use. Throws rather than falling back, because a
 * silent correction would put the child somewhere the operator did not ask
 * for and did not notice.
 */
export function resolveCwd(requested: string | undefined, dirs: readonly string[] = EXTRA_DIRS): string {
  if (requested === undefined) return dirs[0] ?? DEFAULT_CWD;

  // A trailing slash and a parent-relative segment both defeat a prefix
  // match, so compare resolved paths.
  const want = resolve(requested);
  const ok = dirs.some((dir) => {
    const base = resolve(dir);

    return want === base || want.startsWith(`${base}/`);
  });

  if (!ok) {
    throw new Error(
      `refusing to run a supervised child in "${requested}": a child's working directory is ` +
        `always reachable, and this one is outside every allowed directory ` +
        `(${dirs.join(', ')})`,
    );
  }

  return want;
}

/**
 * The narrow starting set.
 *
 * ⚠️ IT DOES NOT CONTAIN BASH, and that is a property of allowlists rather than
 * of this list. `Bash(npm test:*)` runs whatever `package.json` says, and
 * `git commit` runs hooks. **A tool allowlist scopes WHAT, never WHERE.** Real
 * containment needs the OS. Accepted knowingly; open question 1 on #33.
 */
export const DEFAULT_ALLOWLIST = [
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
  ...EDIT_SCOPES,

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
] as const;

/**
 * The allowlist plus a grant lee has just approved.
 *
 * 🛑 ADDITIVE. A grant that replaced the list would silently revoke everything
 * the agent already had, mid-task, and the symptom would be a second denial
 * for something that worked a minute earlier.
 */
export function allowlistWith(granted: readonly string[]): string[] {
  return [...new Set([...DEFAULT_ALLOWLIST, ...granted])];
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
