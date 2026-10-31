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
  'Write',
  'Edit',
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
