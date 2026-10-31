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
 * Directories the agent may edit files in.
 *
 * 🛑 `Edit(<glob>)`, NEVER `Write(<glob>)`. The CLI states the rule itself:
 *
 *   "Write(/Users/leejenkins/context/**) is not matched by file permission
 *    checks — only Edit(path) rules are. Use Edit(...) instead (Edit rules
 *    cover all file-editing tools)."
 *
 * A path-scoped `Write` rule looks like containment and does nothing.
 */
export const EDIT_SCOPES = [
  'Edit(/Users/leejenkins/dev/leagues2/**)',
  'Edit(/Users/leejenkins/dev/chat-mcp2/**)',
  'Edit(/Users/leejenkins/playground/**)',
] as const;

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

  // 🛑 NO BARE `Write` OR `Edit` HERE, AND THAT IS THE WHOLE POINT OF
  // EDIT_SCOPES. A bare entry allows the tool against ANY path, which made
  // the scopes below decorative — a supervised agent could edit any file on
  // the machine. Found by claude1 reviewing PR 34.
  //
  // ⚠️ IT COMPOUNDED WITH THE PERMISSION MODE. `acceptEdits` was justified by
  // a comment claiming no Edit tool existed to accept, which stopped being
  // true the moment Write and Edit were added. Two findings, one outcome.
  //
  // The CLI states that `Edit(<glob>)` governs every file-editing tool, so
  // these three cover Write as well.
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
