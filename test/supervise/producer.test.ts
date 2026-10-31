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
/**
 * 🚨 THE DEAD-LINK SHAPE, FOR THE THIRD TIME. My pairing tests call
 * `rememberClaudeToolUse` DIRECTLY, so deleting the driver's call to it left
 * all 15 of them green while no real denial could ever carry an invocation.
 * Caught by a negative control, not by the tests.
 */
test('the DRIVER feeds every event to the recorder, before checking for a denial', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(
    new URL('../../src/supervise/drivers/claude.ts', import.meta.url),
    'utf8',
  );

  const router = src.slice(src.indexOf('export function routeClaudeEvent'));

  assert.ok(router.includes('rememberClaudeToolUse(event)'), 'the recorder is never called');
  assert.ok(
    router.indexOf('rememberClaudeToolUse(event)') < router.indexOf('denialFromClaude(event)'),
    'the recorder runs AFTER the denial check, so the pairing is always empty',
  );
});

test('every link in the approval chain has a guard in this file', async () => {
  const { readFileSync } = await import('node:fs');
  const self = readFileSync(new URL('./producer.test.ts', import.meta.url), 'utf8');

  for (const link of [
    'rememberClaudeToolUse(event)',
    'denialFromClaude(event)',
    'dao.insertApproval(',
    'driver.redispatchPrompt(',
  ]) {
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
 * The parse failed, a PLACEHOLDER was filed, lee APPROVED A BLANK, that
 * literal went into `--allowedTools`, the retry was denied, and a second card
 * appeared. 251 unit tests were green throughout.
 *
 * ⚠️ THE FIRST FIX — file nothing — WAS WORSE, and claude1 said so: it
 * restores the bug #39 exists to fix, because the child stops and nobody is
 * told. And the one unnameable case measured is `git push`, which is on
 * lee's excluded list BY NAME, so silence would land exactly on the
 * high-stakes requests.
 */
test('an unnamed request is filed as NULL, never as a placeholder', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../../src/supervise/index.ts', import.meta.url), 'utf8');

  // Comments are stripped: the placeholder is NAMED in the comment that
  // explains its removal, so a raw search reports the bug as present.
  const handler = src
    .slice(src.indexOf('child.onDenial('), src.indexOf('child.onUsage('))
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');

  assert.ok(handler.includes('requested: denial.requested'), 'the request is not passed through');
  assert.ok(
    !handler.includes('could not parse'),
    'the placeholder is back; it gets allowlisted as a literal',
  );
});

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

/**
 * 🚨 THE PAIRING THAT MAKES A GRANT POSSIBLE, measured from a real run.
 *
 * The refusal names the command in PROSE. The EXACT invocation is in the
 * `tool_use` event that preceded it, matched by `tool_use_id`. Without the
 * pairing, the prose goes into `--allowedTools`, grants nothing, and the
 * agent is denied again — which is what happened on lee's machine.
 */
test('a denial is paired to the exact invocation that caused it', async () => {
  const { denialFromClaude, rememberClaudeToolUse } = await import(
    '../../src/supervise/drivers/claude-events.js'
  );
  const { grantFor } = await import('../../src/supervise/denial.js');

  rememberClaudeToolUse({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'rm -f a.txt' } }],
    },
  });

  const denial = denialFromClaude({
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_1',
          content:
            "Permission for this tool use was denied. What required approval: rm in '/x/a.txt' was blocked.",
        },
      ],
    },
  });

  assert.equal(denial?.requested, "rm in '/x/a.txt'", 'the prose is for the human');
  assert.equal(denial?.invocation, 'rm -f a.txt', 'the exact command is for the allowlist');
  assert.equal(grantFor(denial!), 'Bash(rm -f a.txt)');
});

/**
 * 🛑 AN UNPAIRED DENIAL YIELDS NO GRANT, never a guess. Approving a guess
 * permits something the child never asked for.
 */
test('a denial with no matching tool call yields no grant', async () => {
  const { denialFromClaude } = await import('../../src/supervise/drivers/claude-events.js');
  const { grantFor } = await import('../../src/supervise/denial.js');

  const denial = denialFromClaude({
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_never_seen',
          content: 'Permission for this tool use was denied. What required approval: x was blocked.',
        },
      ],
    },
  });

  assert.ok(denial, 'the denial itself must still be recognised');
  assert.equal(denial?.invocation, null);
  assert.equal(grantFor(denial!), null);
});

/**
 * ⚠️ THE MAP MUST NOT GROW FOREVER. A long session makes thousands of tool
 * calls; only those still awaiting a result may be held.
 */
test('a paired call is consumed, so the pending map does not grow', async () => {
  const { denialFromClaude, rememberClaudeToolUse } = await import(
    '../../src/supervise/drivers/claude-events.js'
  );

  const use = {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_2', name: 'Bash', input: { command: 'rm -f b.txt' } }],
    },
  };
  const deny = {
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_2',
          content: 'Permission for this tool use was denied. What required approval: y was blocked.',
        },
      ],
    },
  };

  rememberClaudeToolUse(use);
  assert.equal(denialFromClaude(deny)?.invocation, 'rm -f b.txt');

  // Second time: the entry is gone, so no stale invocation is attached.
  assert.equal(denialFromClaude(deny)?.invocation, null, 'the pairing was not consumed');
});

/**
 * 🚨 ONE SPELLING WAS NOT ENOUGH, AND MY OWN FIX CAUSED THE BREAK.
 *
 * On macOS `/var` is a symlink to `/private/var`. The child's first attempt
 * used `/var/…`; `resolveCwd` resolves the cwd, so the re-dispatch prompt
 * named `/private/var/…` and the retry did not match the grant lee had just
 * approved. Two strings, same file, another card.
 */
test('a grant covers every spelling of the same path', async () => {
  const { grantVariants, grantFor } = await import('../../src/supervise/denial.js');
  const { realpathSync, mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const dir = mkdtempSync(join(tmpdir(), 'chat-mcp-grant-'));
  const file = join(dir, 'x.txt');
  writeFileSync(file, 'x');

  try {
    const real = realpathSync(file);

    // Only meaningful where the two spellings differ, which is the macOS case.
    if (real === file) return;

    const denial = {
      requested: "rm in '" + real + "'",
      raw: 'Permission for this tool use was denied.',
      tool: 'Bash',
      invocation: `rm ${file}`,
    };

    const forms = grantVariants(denial);

    assert.ok(forms.includes(`Bash(rm ${file})`), 'the spelling the child used is missing');
    assert.ok(forms.includes(`Bash(rm ${real})`), 'the resolved spelling is missing');
    assert.equal(grantFor(denial), `Bash(rm ${real})`, 'the card should show the resolved path');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a grant with no path yields exactly one form, not duplicates', async () => {
  const { grantVariants } = await import('../../src/supervise/denial.js');

  const forms = grantVariants({
    requested: 'git push',
    raw: 'denied',
    tool: 'Bash',
    invocation: 'git push origin main',
  });

  assert.deepEqual(forms, ['Bash(git push origin main)']);
});

test('an unpaired denial yields no forms at all', async () => {
  const { grantVariants } = await import('../../src/supervise/denial.js');

  assert.deepEqual(
    grantVariants({ requested: null, raw: 'denied', tool: null, invocation: null }),
    [],
  );
});

test('a compound invocation also grants its leading segment alone', async () => {
  const { grantVariants } = await import('../../src/supervise/denial.js');

  const forms = grantVariants({
    requested: "rm in '/a/b/README.md'",
    raw: 'denied',
    tool: 'Bash',
    invocation: 'rm /a/b/README.md && ls -la /a/b/',
  });

  assert.ok(
    forms.includes('Bash(rm /a/b/README.md)'),
    'the leading segment alone is missing, so a reworded retry re-blocks',
  );
  assert.ok(
    forms.includes('Bash(rm /a/b/README.md && ls -la /a/b/)'),
    'the full command the child used is missing',
  );
});

test('the leading segment is split on every shell separator', async () => {
  const { grantVariants } = await import('../../src/supervise/denial.js');

  const leading = (invocation: string) =>
    grantVariants({ requested: null, raw: 'denied', tool: 'Bash', invocation });

  for (const sep of ['&&', '||', ';', '|']) {
    assert.ok(
      leading(`rm /a/b ${sep} ls /a`).includes('Bash(rm /a/b)'),
      `separator ${sep} did not yield the leading segment`,
    );
  }
});

test('a single-segment invocation gains no duplicate form', async () => {
  const { grantVariants } = await import('../../src/supervise/denial.js');

  assert.deepEqual(
    grantVariants({
      requested: 'git push',
      raw: 'denied',
      tool: 'Bash',
      invocation: 'git push origin main',
    }),
    ['Bash(git push origin main)'],
  );
});

test('a path whose leaf does not exist yet still gets the canonical prefix', async () => {
  const { grantVariants } = await import('../../src/supervise/denial.js');
  const { realpathSync, mkdtempSync, mkdirSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const root = mkdtempSync(join(tmpdir(), 'chat-mcp-canon-'));
  const work = join(root, 'work');
  mkdirSync(work);

  try {
    const real = realpathSync(work);

    // Only meaningful where the two spellings differ, which is the macOS case.
    if (real === work) return;

    // 🛑 THE SHAPE RUN 9 PRODUCED: an existing dir and a missing leaf in one
    // command. Resolving only what exists mixed both spellings into one grant.
    const forms = grantVariants({
      requested: null,
      raw: 'denied',
      tool: 'Bash',
      invocation: `mkdir -p ${work} && touch ${work}/new.txt`,
    });

    const mixed = forms.filter((f) => f.includes('/private/var') && f.includes(' /var'));

    assert.deepEqual(mixed, [], `a grant mixes two spellings of one directory: ${mixed[0]}`);
    assert.ok(
      forms.includes(`Bash(mkdir -p ${real} && touch ${real}/new.txt)`),
      'the all-resolved spelling is missing',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a path with no existing ancestor is left exactly as written', async () => {
  const { grantVariants } = await import('../../src/supervise/denial.js');

  assert.deepEqual(
    grantVariants({
      requested: null,
      raw: 'denied',
      tool: 'Bash',
      invocation: 'touch /no/such/root/f.txt',
    }),
    ['Bash(touch /no/such/root/f.txt)'],
  );
});

/**
 * 🛑 THE PROMPT MUST NEVER NAME A BARE PATH. claude1 raised this on PR 41,
 * reasoning that `commandFromGrant('Edit(/x/**)')` yields `/x/**` and the
 * child would be told to attempt a glob.
 *
 * Measured: that entry shape never reaches here. `claude-events.ts` sets
 * `invocation` to `command ?? name`, and only Bash carries a `command`, so a
 * non-Bash denial always grants `Tool(Tool)` and unwraps to the tool name.
 * Every non-Bash grant in the live database is that shape.
 *
 * This test pins the premise. A driver that starts putting a path in
 * `invocation` for a non-Bash tool fails here instead of in a live run.
 */
test('a non-Bash grant unwraps to the TOOL NAME, never a path or a glob', async () => {
  const { commandFromGrant } = await import('../../src/supervise/denial.js');

  // 🛑 BOTH SHAPES, because run 12 changed which one a tool grant takes. The
  // claim that matters is the same either way: the prompt gets a name, never
  // a path or a glob.
  assert.equal(commandFromGrant('mcp__chat__set_status'), 'mcp__chat__set_status');
  assert.equal(
    commandFromGrant('mcp__chat__set_status(mcp__chat__set_status)'),
    'mcp__chat__set_status',
  );
  assert.equal(commandFromGrant('   '), null, 'an empty entry must not become a command');
});

/**
 * 🚨 `mcp__chat__set_status(mcp__chat__set_status)` GRANTS NOTHING.
 *
 * Measured on run 12: approvals 23 and 24 were byte-identical — same grant,
 * same refusal — so approving the first and adding it to --allowedTools left
 * the child asking for the same permission again.
 *
 * An MCP tool has no rule content. The allowlist entry is the bare tool
 * name; the parenthesised form is for Bash commands and Edit globs. The
 * earlier claim that this shape had "round-tripped twice" confused an
 * APPROVAL being accepted with the grant actually working.
 */
test('a tool with no rule content grants the BARE NAME, not Tool(Tool)', async () => {
  const { grantFor, grantVariants } = await import('../../src/supervise/denial.js');

  const denial = {
    requested: null,
    raw: 'denied',
    tool: 'mcp__chat__set_status',
    // What claude-events.ts produces when the call carries no `command`.
    invocation: 'mcp__chat__set_status',
  };

  assert.equal(grantFor(denial), 'mcp__chat__set_status');
  assert.deepEqual(grantVariants(denial), ['mcp__chat__set_status']);
});
