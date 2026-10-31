import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../../src/storage/db.js';
import * as dao from '../../src/storage/dao.js';
import { routeClaudeEvent } from '../../src/supervise/drivers/claude.js';

/**
 * 🛑 THE APPROVAL PATH HAD NO PRODUCER AND THE TESTS COULD NOT SEE IT.
 *
 * `denialFromClaude` was imported and never called; `insertApproval` had no
 * caller in `src/` at all. A live test that inserted the row BY HAND passed,
 * because it started one step after the break. `tsc` cannot catch it either —
 * there is no `noUnusedLocals`. Found by claude1 reviewing PR 34.
 *
 * So these tests run the DRIVER's event router, which is the first link.
 */

const DENIAL_EVENT = {
  type: 'user',
  message: {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        content:
          'Permission for this tool use was denied. It requires approval, and this session ' +
          'has no approval surface. What required approval: rm in \'/tmp/t.txt\' was blocked.',
      },
    ],
  },
};

function sink() {
  const denials: { requested: string | null }[] = [];
  const sessions: string[] = [];

  return {
    denials,
    sessions,
    on: {
      turnEnd: () => undefined,
      usage: () => undefined,
      denial: (d: { requested: string | null }) => denials.push(d),
      session: (id: string) => sessions.push(id),
    },
  };
}

test('a denial event reaches the semantic callback', () => {
  const s = sink();
  routeClaudeEvent(DENIAL_EVENT as never, s.on);

  assert.equal(s.denials.length, 1, 'the producer never fired');
  assert.equal(s.denials[0]?.requested, "rm in '/tmp/t.txt'");
});

/**
 * 🛑 THE FALSE-POSITIVE SIDE. A turn that merely completes must not look like
 * a denial, or the operator is asked to approve things nothing was blocked on.
 */
test('an ordinary result event produces no denial', () => {
  const s = sink();
  routeClaudeEvent({ type: 'result', subtype: 'success' } as never, s.on);

  assert.equal(s.denials.length, 0);
});

test('the session id reaches its callback, because a grant resumes rather than restarts', () => {
  const s = sink();
  routeClaudeEvent({ type: 'system', subtype: 'init', session_id: 'sess-9' } as never, s.on);

  assert.deepEqual(s.sessions, ['sess-9']);
});

/**
 * ⚠️ A driver that does not supply the optional callbacks must not crash the
 * router. A Cursor driver may have no denial signal at all.
 */
test('a router call with no denial or session callback does not throw', () => {
  assert.doesNotThrow(() =>
    routeClaudeEvent(DENIAL_EVENT as never, { turnEnd: () => undefined, usage: () => undefined }),
  );
});

/**
 * The end of the producer chain: a denial becomes a row an operator can see.
 */
test('a denial recorded as an approval is then pending for the operator', () => {
  const db = new DatabaseSync(':memory:');
  migrate(db);

  const s = sink();
  routeClaudeEvent(DENIAL_EVENT as never, s.on);

  const denial = s.denials[0]!;
  dao.insertApproval(db, {
    agentHandle: 'claude2-agent',
    supervisorHandle: 'claude2',
    requested: denial.requested ?? '(unparsed)',
    reason: 'raw',
    sessionId: 'sess-9',
  });

  const pending = dao.pendingApprovals(db);
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.requested, "rm in '/tmp/t.txt'");
});

/**
 * 🛑 THE DEAD-LINK GUARD. This is the shape of bug that shipped: a function
 * imported and never called, invisible to `tsc` and to every unit test that
 * started downstream of it.
 */
test('the supervisor actually CALLS insertApproval — not just imports it', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../../src/supervise/index.ts', import.meta.url), 'utf8');

  assert.ok(src.includes('dao.insertApproval('), 'the supervisor records no denial anywhere');
  assert.ok(src.includes('child.onDenial('), 'the supervisor never subscribes to denials');
});

test('the driver actually CALLS denialFromClaude — not just imports it', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(
    new URL('../../src/supervise/drivers/claude.ts', import.meta.url),
    'utf8',
  );

  assert.ok(src.includes('denialFromClaude(event)'), 'the detector is imported and never called');
});

/**
 * 🛑 THE THIRD LINK, WHICH THE FIRST VERSION OF THIS FILE DID NOT GUARD.
 *
 * Guarding links 1 and 2 and not 3 is WORSE than guarding none, because the
 * file reads as "the path is whole". `driver.redispatchPrompt` was declared
 * on the registry and never read: an Approve woke the supervisor,
 * `formatPrompt` rendered it as an ordinary chat line, and the template
 * measured at 3 of 3 never ran. Found by claude1 reviewing PR 34.
 */
test('the supervisor actually CALLS redispatchPrompt — not just registers it', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../../src/supervise/index.ts', import.meta.url), 'utf8');

  assert.ok(
    src.includes('driver.redispatchPrompt('),
    'the re-dispatch template is registered and never run',
  );
});

/**
 * 🛑 AN ANSWER MUST NOT BE RENDERED AS A CHAT MESSAGE. That is precisely the
 * failure: `formatPrompt` is the chat renderer, and routing an approval
 * through it loses the three clauses the child needs.
 */
test('an approval answer bypasses formatPrompt', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../../src/supervise/index.ts', import.meta.url), 'utf8');

  // The approval branch must RETURN before the chat renderer is reached.
  const accept = src.slice(src.indexOf('WakeListener.bind('));
  const approvalAt = accept.indexOf('applyAnswer(envelope.approval)');
  const formatAt = accept.indexOf('formatPrompt(envelope)');

  assert.notEqual(approvalAt, -1, 'an answer is never handled as an answer');
  assert.notEqual(formatAt, -1, 'the chat path is gone; this check is stale');
  assert.ok(approvalAt < formatAt, 'the chat renderer runs before the answer is handled');
  assert.ok(
    /applyAnswer\(envelope\.approval\);[\s\S]{0,120}return/.test(accept),
    'the answer branch falls through into the chat renderer',
  );
});

/**
 * ⚠️ EVERY LINK NEEDS A GUARD OR THE SET OF GUARDS IS THE LIE. Enumerated so
 * adding a fourth link without a guard is visible rather than invisible.
 */
test('every link in the approval chain has a guard in this file', async () => {
  const { readFileSync } = await import('node:fs');
  const self = readFileSync(new URL('./producer.test.ts', import.meta.url), 'utf8');

  for (const link of ['denialFromClaude(event)', 'dao.insertApproval(', 'driver.redispatchPrompt(']) {
    assert.ok(self.includes(link), `no guard asserts the call to ${link}`);
  }
});

/**
 * 🚨 MEASURED END TO END ON 2026-10-31, AND IT COST A LIVE APPROVAL LOOP.
 *
 * A `git push` denial's clause is a REASON, not a command:
 *
 *   "What required approval: This command changes directory before running a
 *    version-control command… Approve only if you trust it."
 *
 * The parse failed, `(could not parse the request)` was filed, lee APPROVED A
 * BLANK, that literal went into `--allowedTools`, the retry was denied again,
 * and a second card appeared. 249 unit tests were green throughout.
 */
test('a denial whose request cannot be NAMED is not filed as an approval', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../../src/supervise/index.ts', import.meta.url), 'utf8');

  // ⚠️ COMMENTS STRIPPED FIRST. The placeholder is NAMED in the comment that
  // explains why it was removed, so a raw text search finds it and reports
  // the bug as present. Same mistake as the guard keys.
  const handler = src
    .slice(src.indexOf('child.onDenial('), src.indexOf('child.onUsage('))
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');

  assert.ok(handler.length > 0, 'the denial handler moved; this check is stale');

  assert.ok(
    /if \(!denial\.requested\)[\s\S]{0,400}return;/.test(handler),
    'an unnamed denial still files an approval',
  );
  assert.ok(
    !handler.includes('could not parse the request'),
    'the placeholder is back; it gets allowlisted as a literal',
  );
});

/**
 * 🛑 THE REAL `git push` TEXT, as a fixture. A paraphrase would let the
 * parser pass against wording the CLI does not emit.
 */
test('the real git-push denial parses to NULL, not to a placeholder', async () => {
  const { denialFromClaude } = await import('../../src/supervise/drivers/claude-events.js');

  const real =
    'Permission for this tool use was denied. It requires approval, and this session has no ' +
    'approval surface — nobody can answer a permission prompt here — so it was denied ' +
    'automatically. The action was NOT performed; do not claim it succeeded, and do not retry ' +
    'it: this action, and anything else that requires approval, will be denied the same way ' +
    'for the rest of this session. Tell the user what was blocked and why you needed it, then ' +
    'continue with the parts of the task that do not require approval. What required approval: ' +
    'This command changes directory before running a version-control command, which can pick ' +
    'up untrusted hooks or repository configuration from the target directory. Approve only ' +
    'if you trust it.';

  const denial = denialFromClaude({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', content: real }] },
  });

  assert.ok(denial, 'the denial itself is not recognised');
  assert.equal(denial?.requested, null, 'a prose reason was mistaken for a command');
});
