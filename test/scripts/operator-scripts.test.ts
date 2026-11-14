import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 🛑 THIS FILE EXISTS BECAUSE `[ -n "$H" ] || usage; exit 2` SHIPPED.
 *
 * The `;` ends the `||` list, so `exit 2` ran UNCONDITIONALLY and every verb
 * needing a handle exited 2 before doing anything. `bash -n` passes it,
 * shellcheck does not flag it, and three manual smoke runs of OTHER verbs
 * missed it. Only asserting the exit code of each documented call catches it.
 *
 * ⚠️ EVERY CALL BELOW MUST BE SIDE-EFFECT FREE. No verb here may start a
 * container, bind a port or spawn a supervisor — `CHAT_MCP_HOME` is a temp dir
 * and the cases are limited to help, usage errors and refusals.
 */

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const HOME_DIR = mkdtempSync(join(tmpdir(), 'chat-mcp-scripts-'));

function run(script: 'agent' | 'web', args: string[]): number {
  try {
    execFileSync(join(REPO, 'scripts', script), args, {
      env: { ...process.env, CHAT_MCP_HOME: HOME_DIR, NODE_TEST_CONTEXT: undefined },
      stdio: 'pipe',
    });
    return 0;
  } catch (err) {
    const e = err as { status?: number };
    return e.status ?? -1;
  }
}

// The exit codes the doc promises. Keep this table and the `Exit codes`
// section of docs/system/07-operations/operator-scripts.md identical.
const CASES: ReadonlyArray<[ 'agent' | 'web', string[], number, string ]> = [
  ['agent', ['--help'], 0, 'help is not an error'],
  ['agent', ['-h'], 0, 'short help too'],
  ['agent', ['help'], 0, 'bare word help too'],
  ['agent', [], 2, 'no arguments is bad usage'],
  ['agent', ['bogus', 'x'], 2, 'an unknown verb is bad usage'],
  ['agent', ['start'], 2, '🛑 a verb that NEEDS a handle, with none, is bad usage'],
  ['agent', ['stop'], 2, 'same for stop'],
  ['agent', ['restart'], 2, 'same for restart'],
  ['agent', ['status'], 0, 'status with no handle lists, it does not refuse'],
  ['agent', ['status', 'BadCaps'], 1, 'an invalid handle is a refusal, not bad usage'],
  ['agent', ['status', '../traversal'], 1, 'a traversal attempt is refused'],
  ['agent', ['status', 'validhandle'], 0, '⚠️ control — a valid handle reports, exit 0'],
  ['web', ['--help'], 0, 'help is not an error'],
  ['web', [], 2, 'no arguments is bad usage'],
  ['web', ['bogus'], 2, 'an unknown verb is bad usage'],
  ['web', ['start', 'BadCaps'], 1, 'an invalid handle is refused before anything binds'],
  ['web', ['status'], 0, 'status always answers'],
];

for (const [script, args, expected, why] of CASES) {
  test(`${why} — ./scripts/${script} ${args.join(' ') || '(no args)'} -> ${expected}`, () => {
    assert.equal(run(script, args), expected);
  });
}

/**
 * The regression itself, stated as the thing it broke rather than as a code
 * shape: asking for a verb that needs a handle, WITH one, must not be bad
 * usage. Before the fix this returned 2 for every such call.
 */
test('🛑 a handle-taking verb given a handle is never bad usage', () => {
  for (const verb of ['stop', 'restart']) {
    const code = run('agent', [verb, 'validhandle']);
    assert.notEqual(code, 2, `./scripts/agent ${verb} validhandle returned bad-usage`);
  }
});
