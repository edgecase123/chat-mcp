import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveCwd } from '../../src/supervise/allowlist.js';

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

/**
 * 🛑 REAL DIRECTORIES ON DISK, because the check now uses `realpathSync`.
 * Fictional paths used to pass a lexical comparison, which is precisely the
 * hole: a symlink inside an allowed directory escaped it.
 */
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'chat-mcp-cwd-')));
const ALLOWED = join(ROOT, 'allowed');
const SUB = join(ALLOWED, 'sub', 'deep');
const SIBLING = join(ROOT, 'allowed-evil');
const OUTSIDE = join(ROOT, 'outside');

mkdirSync(SUB, { recursive: true });
mkdirSync(SIBLING, { recursive: true });
mkdirSync(OUTSIDE, { recursive: true });
symlinkSync(OUTSIDE, join(ALLOWED, 'link'));

process.on('exit', () => rmSync(ROOT, { recursive: true, force: true }));

const DIRS = [ALLOWED];

test('an unset cwd defaults into the allowed set, never to process.cwd()', () => {
  assert.equal(resolveCwd(undefined, DIRS), ALLOWED);
});

/**
 * 🛑 THE DEFAULT GOES THROUGH THE SAME PREDICATE. It used to be returned
 * unvalidated, so an unset cwd succeeded against an empty directory list
 * while naming the same path explicitly threw. Raised by claude1.
 */
test('the default is validated, not just returned', () => {
  assert.throws(() => resolveCwd(undefined, []), /at least one allowed directory/);
});

test('a cwd inside an allowed directory is accepted', () => {
  assert.equal(resolveCwd(ALLOWED, DIRS), ALLOWED);
});

test('a SUBDIRECTORY of an allowed directory is accepted', () => {
  assert.equal(resolveCwd(SUB, DIRS), SUB);
});

/**
 * 🚨 THE LEXICAL HOLE. `resolve()` is textual, so a symlink inside an allowed
 * directory pointed anywhere and passed. Measured before the fix:
 * `~/playground/evil-link` was ACCEPTED while its real location was
 * `/private/etc`. Found by claude1.
 */
test('a SYMLINK inside an allowed directory that points outside is refused', () => {
  assert.throws(() => resolveCwd(join(ALLOWED, 'link'), DIRS), /refusing to run/);
});

/** ⚠️ A missing directory must not read as a containment refusal. */
test('a directory that does not exist says so, not "outside the allowed set"', () => {
  assert.throws(() => resolveCwd(join(ROOT, 'nope'), DIRS), /does not exist/);
});

/**
 * 🚨 THE CASE THAT MOTIVATED THIS. Launching the supervisor from the sibling
 * agent's tree would have handed the child that tree.
 */
test('a cwd outside every allowed directory is REFUSED', () => {
  assert.throws(() => resolveCwd(OUTSIDE, DIRS), /refusing to run/);
});

test('the refusal names the directory and what was allowed', () => {
  try {
    resolveCwd('/etc', DIRS);
    assert.fail('an arbitrary system path was accepted');
  } catch (err) {
    assert.match((err as Error).message, /etc/);
    assert.match((err as Error).message, /allowed/);
  }
});

/**
 * 🛑 A PREFIX MATCH IS NOT ENOUGH. `/Users/leejenkins/playground-evil` starts
 * with an allowed directory's text and is a different directory.
 */
test('a sibling directory sharing a name PREFIX is refused', () => {
  assert.throws(() => resolveCwd(SIBLING, DIRS), /refusing to run/);
});

/**
 * ⚠️ A traversal segment defeats a naive string compare, so paths are
 * resolved before the check.
 */
test('a path that escapes via .. is refused', () => {
  assert.throws(() => resolveCwd(join(ALLOWED, '..', 'outside'), DIRS), /refusing to run/);
});

test('a trailing slash does not change the verdict', () => {
  assert.equal(resolveCwd(`${ALLOWED}/`, DIRS), ALLOWED);
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
