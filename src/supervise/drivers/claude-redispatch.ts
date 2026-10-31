/**
 * The prompt that re-dispatches a CLAUDE CODE child after lee grants a
 * permission.
 *
 * 🛑 THIS IS DRIVER WORDING, NOT A GENERIC TEMPLATE, AND A SEAM TEST CAUGHT IT
 * SITTING ABOVE THE DRIVER. It names `--allowedTools`, which is Claude Code's
 * flag. Another CLI needs its own wording, and the 3-of-3 result below is
 * evidence about THIS CLI only.
 *
 * 🛑 A TEMPLATE WITH A TEST, NOT A STRING AT A CALL SITE, BECAUSE A VAGUE
 * VERSION FAILS BY REFUSING. Measured 2026-10-31 over five live runs:
 *
 *   "Permission was granted. Please run that command now."   0 of 2 worked
 *   the template below                                       3 of 3 worked
 *
 * The child remembers the denial and quotes it back — *"the denial applies to
 * every approval-requiring action for the rest of the session"* — and then
 * declines to try. **It has to be told WHY that changed, not just that it
 * did.** A refusal looks like a stubborn model rather than a bad prompt, which
 * is how the first reading of this got it wrong for an hour.
 *
 * ⚠️ This also corrected an earlier conclusion: `--resume` is NOT poisoned by a
 * denial. The flags were identical in the working and failing runs; only the
 * prompt differed. So a grant keeps the whole session instead of respawning.
 */

export interface RedispatchClause {
  /** What the clause is for, used as the validator's failure name. */
  readonly name: string;
  /** Evidence the clause is present. Removing a match must fail the check. */
  readonly pattern: RegExp;
}

/**
 * The three things the prompt must say. Dropping any one returns you to the
 * version that refused twice.
 */
export const REQUIRED_CLAUSES: readonly RedispatchClause[] = [
  { name: 'new-invocation', pattern: /This is a NEW invocation\./ },
  { name: 'now-allowlisted', pattern: /is now explicitly in --allowedTools for this session/ },
  { name: 'denial-superseded', pattern: /the earlier denial no longer applies/ },
];

/** Which required clauses a prompt is missing. Empty means it is well formed. */
export function missingClauses(prompt: string): string[] {
  return REQUIRED_CLAUSES.filter((c) => !c.pattern.test(prompt)).map((c) => c.name);
}

export interface RedispatchInput {
  /** The command lee approved, verbatim, so the child recognises it. */
  readonly grantedCommand: string;
  /** What the child should do once it is unblocked. */
  readonly followUp: string;
}

export function redispatchPrompt(input: RedispatchInput): string {
  const command = input.grantedCommand.trim();

  // 🛑 An empty command would produce a prompt that passes every clause check
  // and tells the child nothing. Fail loudly instead.
  if (command.length === 0) {
    throw new Error('redispatchPrompt needs the granted command, verbatim');
  }

  const prompt = [
    'This is a NEW invocation.',
    `The command \`${command}\` is now explicitly in --allowedTools for this session,`,
    'so the earlier denial no longer applies.',
    `Please attempt \`${command}\` now and report what the tool returns.`,
    input.followUp.trim(),
  ]
    .filter((line) => line.length > 0)
    .join(' ');

  // 🛑 The guard runs on the way out, so a future edit to the lines above
  // cannot quietly drop a clause the five live runs paid for.
  const missing = missingClauses(prompt);
  if (missing.length > 0) {
    throw new Error(`redispatchPrompt lost required clause(s): ${missing.join(', ')}`);
  }

  return prompt;
}
