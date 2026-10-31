import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REQUIRED_CLAUSES,
  missingClauses,
  redispatchPrompt,
} from '../../src/supervise/drivers/claude-redispatch.js';
import { DEFAULT_ALLOWLIST, EDIT_SCOPES, allowlistWith } from '../../src/supervise/allowlist.js';

/**
 * 🛑 A VAGUE RE-DISPATCH PROMPT FAILS BY REFUSING, WHICH LOOKS LIKE A STUBBORN
 * MODEL RATHER THAN A BAD PROMPT. That is why this is a tested template and
 * not a string literal at a call site.
 *
 * Measured 2026-10-31, five live runs:
 *
 *   "Permission was granted. Please run that command now."   0 of 2 worked
 *   the explicit template below                              3 of 3 worked
 *
 * The child remembers being denied and quotes it back — *"the denial applies
 * to every approval-requiring action for the rest of the session"*. It has to
 * be told WHY that changed, not just that it did.
 */

const VAGUE = 'Permission was granted. Please run that command now.';

test('the vague prompt that actually failed twice is REJECTED by the validator', () => {
  const missing = missingClauses(VAGUE);

  assert.notDeepEqual(missing, [], 'the validator accepts the prompt that refused twice');
});

test('the template satisfies every required clause', () => {
  const prompt = redispatchPrompt({
    grantedCommand: 'rm -f target.txt',
    followUp: 'Please carry on with the task.',
  });

  assert.deepEqual(missingClauses(prompt), []);
});

/**
 * 🛑 ONE TEST PER CLAUSE, because "all three present" passes on a template that
 * happens to contain them for unrelated reasons, and dropping any one returns
 * you to the version that refused.
 */
for (const clause of REQUIRED_CLAUSES) {
  test(`a prompt missing the "${clause.name}" clause is rejected`, () => {
    const prompt = redispatchPrompt({
      grantedCommand: 'rm -f target.txt',
      followUp: 'Please carry on with the task.',
    });

    // Remove just this clause's evidence and nothing else.
    const damaged = prompt.replace(clause.pattern, '');

    assert.deepEqual(
      missingClauses(damaged),
      [clause.name],
      `removing "${clause.name}" was not detected, so its check proves nothing`,
    );
  });
}

test('the granted command appears verbatim, because the child must recognise it', () => {
  const prompt = redispatchPrompt({
    grantedCommand: 'git push origin main',
    followUp: 'carry on',
  });

  assert.ok(prompt.includes('git push origin main'));
});

test('the template refuses to build without a granted command', () => {
  assert.throws(() => redispatchPrompt({ grantedCommand: '   ', followUp: 'carry on' }));
});

/**
 * ⚠️ `Write(<glob>)` IS SILENTLY IGNORED — the CLI said so itself:
 * *"Write(...) is not matched by file permission checks — only Edit(path)
 * rules are … Edit rules cover all file-editing tools."* A path-scoped Write
 * rule looks like containment and is not.
 */
test('every path-scoped rule uses Edit, never Write', () => {
  for (const scope of EDIT_SCOPES) {
    assert.match(scope, /^Edit\(/, `path scoping must be Edit(...), got: ${scope}`);
  }

  const pathScopedWrites = DEFAULT_ALLOWLIST.filter((t) => /^Write\(/.test(t));
  assert.deepEqual(pathScopedWrites, [], 'a Write(<glob>) rule is silently ignored');
});

/**
 * ⚠️ THIS TEST USED TO REQUIRE BARE `Write` AND `Edit`, WHICH IS THE BUG IT
 * SHOULD HAVE CAUGHT. It encoded "lee asked for Write and Edit" literally,
 * and a bare entry allows the tool against ANY path, making every
 * `Edit(<glob>)` scope decorative. What lee asked for is the CAPABILITY.
 */
test('the allowlist grants what lee asked for, and excludes what he excluded', () => {
  const joined = DEFAULT_ALLOWLIST.join(' ');

  for (const wanted of ['Read', 'Bash(git commit:*)']) {
    assert.ok(DEFAULT_ALLOWLIST.includes(wanted), `missing: ${wanted}`);
  }

  assert.ok(
    DEFAULT_ALLOWLIST.some((t) => t.startsWith('Edit(')),
    'file editing was asked for and no scope grants it',
  );

  for (const forbidden of ['git push', 'Bash(rm', 'deploy']) {
    assert.ok(!joined.includes(forbidden), `must not be pre-approved: ${forbidden}`);
  }
});

/**
 * 🛑 A GRANT IS ADDITIVE AND SCOPED TO THE ONE COMMAND. A grant that replaced
 * the allowlist would silently revoke everything the agent already had.
 */
test('a grant ADDS to the allowlist and keeps every default', () => {
  const granted = allowlistWith(['Bash(rm:*)']);

  assert.ok(granted.includes('Bash(rm:*)'), 'the grant is missing');

  for (const base of DEFAULT_ALLOWLIST) {
    assert.ok(granted.includes(base), `the grant revoked: ${base}`);
  }
});

test('a grant does not duplicate something already allowed', () => {
  const granted = allowlistWith(['Read']);

  assert.equal(granted.filter((t) => t === 'Read').length, 1);
});
