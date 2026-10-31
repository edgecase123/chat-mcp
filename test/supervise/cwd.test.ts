import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveCwd, DEFAULT_CWD, EXTRA_DIRS } from '../../src/supervise/allowlist.js';

/**
 * 🛑 THE CWD IS A THIRD CONTAINMENT INPUT AND IT HAD NO DEFAULT.
 *
 * `allowed` says WHICH paths. `extraDirs` makes paths REACHABLE. A child's
 * WORKING DIRECTORY is reachable by definition — so an unset one silently
 * inherits wherever the operator launched the supervisor, and from
 * `~/dev/leagues` that is the sibling agent's live tree. Found by claude1.
 *
 * ⚠️ NO CHEAP MEASUREMENT COULD SETTLE IT, because every live run so far
 * held the cwd at a directory already inside `EXTRA_DIRS`. That is the same
 * two-variable confound that produced the previous wrong conclusion, so this
 * is closed by construction rather than answered by a probe.
 */

const DIRS = ['/Users/leejenkins/playground', '/Users/leejenkins/dev/chat-mcp2'];

test('an unset cwd defaults into the allowed set, never to process.cwd()', () => {
  assert.equal(resolveCwd(undefined, DIRS), DIRS[0]);
});

test('the default is one of the allowed directories, not an arbitrary path', () => {
  assert.ok(EXTRA_DIRS.includes(DEFAULT_CWD), 'the default cwd is outside the reachable set');
});

test('a cwd inside an allowed directory is accepted', () => {
  assert.equal(resolveCwd('/Users/leejenkins/playground', DIRS), '/Users/leejenkins/playground');
});

test('a SUBDIRECTORY of an allowed directory is accepted', () => {
  assert.equal(
    resolveCwd('/Users/leejenkins/playground/sub/deep', DIRS),
    '/Users/leejenkins/playground/sub/deep',
  );
});

/**
 * 🚨 THE CASE THAT MOTIVATED THIS. Launching the supervisor from the sibling
 * agent's tree would have handed the child that tree.
 */
test('a cwd outside every allowed directory is REFUSED', () => {
  assert.throws(() => resolveCwd('/Users/leejenkins/dev/leagues', DIRS), /refusing to run/);
});

test('the refusal names the directory and what was allowed', () => {
  try {
    resolveCwd('/etc', DIRS);
    assert.fail('an arbitrary system path was accepted');
  } catch (err) {
    assert.match((err as Error).message, /\/etc/);
    assert.match((err as Error).message, /playground/);
  }
});

/**
 * 🛑 A PREFIX MATCH IS NOT ENOUGH. `/Users/leejenkins/playground-evil` starts
 * with an allowed directory's text and is a different directory.
 */
test('a sibling directory sharing a name PREFIX is refused', () => {
  assert.throws(() => resolveCwd('/Users/leejenkins/playground-evil', DIRS), /refusing to run/);
});

/**
 * ⚠️ A traversal segment defeats a naive string compare, so paths are
 * resolved before the check.
 */
test('a path that escapes via .. is refused', () => {
  assert.throws(() => resolveCwd('/Users/leejenkins/playground/../../etc', DIRS), /refusing to run/);
});

test('a trailing slash does not change the verdict', () => {
  assert.equal(resolveCwd('/Users/leejenkins/playground/', DIRS), '/Users/leejenkins/playground');
});

/**
 * 🛑 IT MUST THROW BEFORE ANYTHING SPAWNS. Validating after the child exists
 * would mean the hole was already open.
 */
test('the supervisor resolves the cwd and passes it to the spawn', () => {
  const src = readFileSync(new URL('../../src/supervise/index.ts', import.meta.url), 'utf8');

  assert.ok(src.includes('resolveCwd('), 'the supervisor never validates the cwd');
  assert.ok(
    src.includes('cwd: childCwd'),
    'the validated cwd is computed and then not given to the child',
  );
});
