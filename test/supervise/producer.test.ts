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

  assert.ok(
    /envelope\.approval\s*\?\s*applyAnswer\(/.test(src),
    'an answer still goes through the chat renderer',
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
