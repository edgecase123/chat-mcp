import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

/**
 * 🛑 THE GATE'S VERDICT MUST NOT DEPEND ON THE TREE IT RAN IN.
 *
 * `scripts/test-scroll.mjs` was a hand-written diagnostic, not a test. Its
 * name matched node's default discovery glob, so `npm test` imported it, and
 * it imported `dist/` — which is gitignored. In a built tree the suite passed;
 * in a fresh clone the same commit exited 1. main was reported red while it
 * was green (#46).
 *
 * Both halves are guarded here: discovery must stay scoped, and nothing
 * outside `test/` may be discoverable in the first place.
 */

/** Node's default test-file patterns, as names rather than globs. */
function looksDiscoverable(path: string): boolean {
  const file = path.split('/').pop() ?? '';
  return /(^|[.\-_])test\.[cm]?[jt]s$/.test(file)
    || /\.test\.[cm]?[jt]s$/.test(file)
    || /^test-.*\.[cm]?[jt]s$/.test(file)
    || /[.\-_]test\.[cm]?[jt]s$/.test(file);
}

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);
}

test('the test script names where tests live, rather than letting node guess', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> };

  assert.match(
    pkg.scripts.test ?? '',
    /test\/\*\*/,
    'npm test must scope discovery to test/, or any stray test-*.mjs is a gate input',
  );
});

test('🛑 no tracked file OUTSIDE test/ is discoverable as a test', () => {
  const strays = trackedFiles()
    .filter((f) => !f.startsWith('test/'))
    .filter(looksDiscoverable);

  assert.deepEqual(
    strays,
    [],
    `these would be run as tests if discovery were ever unscoped: ${strays.join(', ')}`,
  );
});

test('the guard can actually see a stray, so an empty result means something', () => {
  // Without this, the test above passes just as well with a broken matcher.
  assert.equal(looksDiscoverable('scripts/test-scroll.mjs'), true);
  assert.equal(looksDiscoverable('scripts/foo.test.ts'), true);
  assert.equal(looksDiscoverable('scripts/foo_test.mjs'), true);
  assert.equal(looksDiscoverable('scripts/scroll-diagnostic.mjs'), false);
});

test('no tracked test file imports dist/, which is gitignored', () => {
  const offenders = trackedFiles()
    .filter((f) => f.startsWith('test/') && f.endsWith('.ts'))
    .filter((f) => /from '[^']*\/dist\//.test(readFileSync(f, 'utf8')));

  assert.deepEqual(offenders, [], `a test importing dist/ fails in a fresh clone: ${offenders.join(', ')}`);
});
