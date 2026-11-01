import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildHints,
  isInside,
  realContainedDir,
  resolveHintQuery,
  HINT_LIMIT,
} from '../../src/cli/web/file-hints.js';

const ROOTS = { cwd: '/proj', home: '/home/lee' };
const q = (token: string) => resolveHintQuery(token, ROOTS);

// ── where a token resolves ──────────────────────────────────────────────

test('a bare token lists the project folder', () => {
  assert.deepEqual(q(''), { dirAbs: '/proj', root: '/proj', prefix: '', rebuild: '' });
});

test('a relative token resolves against the project folder, never the home one', () => {
  assert.deepEqual(q('src/lo'), { dirAbs: '/proj/src', root: '/proj', prefix: 'lo', rebuild: 'src/' });
});

test('"~/" resolves against the home directory', () => {
  assert.deepEqual(q('~/dev/le'), {
    dirAbs: '/home/lee/dev',
    root: '/home/lee',
    prefix: 'le',
    rebuild: '~/dev/',
  });
});

test('"~" alone lists the home directory', () => {
  assert.deepEqual(q('~'), { dirAbs: '/home/lee', root: '/home/lee', prefix: '', rebuild: '~/' });
});

test('the rebuild keeps the shape the user typed, so accepting does not rewrite it', () => {
  assert.equal(q('~/dev/')!.rebuild, '~/dev/', 'a tilde token stays a tilde token');
  assert.equal(q('src/')!.rebuild, 'src/', 'and a relative one stays relative');
});

// ── what it refuses ─────────────────────────────────────────────────────

test('🛑 an ABSOLUTE token is refused. There is no root to contain it.', () => {
  assert.equal(q('/etc/passwd'), null);
  assert.equal(q('/'), null);
  // ⚠️ TWO GUARDS COVER THIS, so no single mutant can fail this test. The
  // explicit startsWith check and the containment test each refuse it alone.
  // Measured 2026-11-01: removing BOTH is what turns this red.
  assert.equal(q('/proj/src/'), null, 'refused even when it names the root itself');
});

test('🛑 a token cannot climb OUT of the project folder', () => {
  // Without the containment test this lists the filesystem.
  assert.equal(q('../'), null);
  assert.equal(q('../../etc/'), null);
  assert.equal(q('src/../../../'), null);
});

test('🛑 a "~" token cannot climb out of the home directory either', () => {
  assert.equal(q('~/../'), null);
  assert.equal(q('~/../../etc/'), null);
});

test('climbing and returning is allowed, because it never leaves', () => {
  assert.deepEqual(q('src/../web/')!.dirAbs, '/proj/web', 'it resolves back inside');
});

test('a NUL byte is refused before it reaches the filesystem', () => {
  assert.equal(q('src/\0'), null);
});

test('the query names the root it was contained against, so the caller need not re-derive it', () => {
  assert.equal(q('src/lo')!.root, '/proj', 'a relative token is held to the project folder');
  assert.equal(q('~/dev/')!.root, '/home/lee', 'and a tilde token to the home one');
});

test('isInside accepts the root itself and rejects a sibling with a shared prefix', () => {
  assert.equal(isInside('/proj', '/proj'), true);
  assert.equal(isInside('/proj/src', '/proj'), true);
  assert.equal(isInside('/project-other', '/proj'), false, 'a string prefix is not containment');
  assert.equal(isInside('/', '/proj'), false);
});

// ── the symlink escape, on real directories ─────────────────────────────

/**
 * 🛑 REAL DIRECTORIES ON DISK, because this half of the containment uses
 * `realpath`. The string fixtures above are exactly the condition under which
 * the hole passes: `path.resolve` and `isInside` are both lexical, so a
 * symlink that POINTS outside is still textually inside.
 *
 * `@esc/etc/` listed `/etc` over HTTP before this. Found by claude1, and the
 * same hole `test/supervise/cwd.test.ts` already records in the supervise path.
 *
 * ⚠️ realpathSync on the tmpdir root is not optional. On macOS `tmpdir()` is
 * itself a symlink, so a lexical root would refuse paths genuinely inside it.
 */
const DISK = realpathSync(mkdtempSync(join(tmpdir(), 'chat-mcp-hints-')));
const PROJ = join(DISK, 'proj');
const OUTSIDE = join(DISK, 'outside');

mkdirSync(join(PROJ, 'real'), { recursive: true });
mkdirSync(join(OUTSIDE, 'secret'), { recursive: true });
symlinkSync(OUTSIDE, join(PROJ, 'esc'));
symlinkSync(join(PROJ, 'real'), join(PROJ, 'inner'));
// A root reached THROUGH a symlink, which is what tmpdir() is on macOS.
symlinkSync(PROJ, join(DISK, 'alias'));

process.on('exit', () => rmSync(DISK, { recursive: true, force: true }));

const onDisk = (token: string) => {
  const query = resolveHintQuery(token, { cwd: PROJ, home: PROJ });
  assert.ok(query, `the lexical pass refused "${token}" before realpath was reached`);

  return realContainedDir(query);
};

test('🚨 a SYMLINK inside the root that points OUTSIDE is refused', async () => {
  assert.equal(await onDisk('esc/'), null, 'the escape itself');
  assert.equal(await onDisk('esc/secret/'), null, 'and anything under it');
});

test('a symlink inside the root that points back INSIDE still works', async () => {
  assert.equal(await onDisk('inner/'), join(PROJ, 'real'), 'resolved to its real location');
});

test('a plain directory inside the root is accepted', async () => {
  assert.equal(await onDisk('real/'), join(PROJ, 'real'));
});

test('the root itself is accepted', async () => {
  assert.equal(await onDisk(''), PROJ);
});

/** ⚠️ A path that does not exist yet is the normal case while typing. */
test('a directory that does not exist refuses rather than throwing', async () => {
  assert.equal(await onDisk('nope/'), null);
});

/**
 * ⚠️ THE ROOT IS RESOLVED TOO, and this is the only test that says so.
 * `realpath(dirAbs)` alone refuses a root reached through a symlink, because
 * the real directory is not textually inside the aliased root. On macOS
 * `tmpdir()` is exactly that, so this is the live case and not a contrivance.
 */
test('a root reached through a symlink still contains its own children', async () => {
  const alias = join(DISK, 'alias');
  const query = resolveHintQuery('real/', { cwd: alias, home: alias })!;
  assert.equal(await realContainedDir(query), join(PROJ, 'real'));
});

/**
 * 🛑 THE NEGATIVE CONTROL. Without this the suite cannot tell a working guard
 * from a fixture that never had a symlink in it. An identity realpath is the
 * pre-fix behaviour, and the escape must be ALLOWED under it.
 */
test('the escape IS allowed when realpath is stubbed out, so the fixture does reach it', async () => {
  const query = resolveHintQuery('esc/', { cwd: PROJ, home: PROJ })!;
  const lexical = await realContainedDir(query, async (x) => x);
  assert.equal(lexical, join(PROJ, 'esc'), 'the lexical pass alone lets the escape through');
});

// ── how a listing is shaped ─────────────────────────────────────────────

const E = (name: string, isDirectory = false) => ({ name, isDirectory });
const build = (entries: { name: string; isDirectory: boolean }[], prefix = '', rebuild = '') =>
  buildHints(entries, { prefix, rebuild }).map((h) => h.value);

test('directories come before files, each group alphabetical', () => {
  assert.deepEqual(
    build([E('b.ts'), E('src', true), E('a.ts'), E('web', true)]),
    ['@src/', '@web/', '@a.ts', '@b.ts'],
  );
});

test('a directory gets a trailing slash, so you can keep drilling down', () => {
  assert.deepEqual(build([E('src', true)]), ['@src/']);
  assert.deepEqual(build([E('x.ts')]), ['@x.ts']);
});

test('🛑 dotfiles are hidden until the prefix opens with a dot', () => {
  const entries = [E('.git', true), E('src', true)];
  assert.deepEqual(build(entries), ['@src/'], 'otherwise "@" is a wall of dotfiles');
  assert.deepEqual(build(entries, '.'), ['@.git/']);
});

test('the prefix filter ignores case', () => {
  assert.deepEqual(build([E('README.md'), E('other')], 'read'), ['@README.md']);
});

test('the rebuild prefixes every value, so a nested accept keeps its directory', () => {
  assert.deepEqual(build([E('logic.js')], 'lo', 'web/assets/'), ['@web/assets/logic.js']);
});

test(`🛑 the reply is capped at ${HINT_LIMIT}, so one keystroke cannot return a huge directory`, () => {
  const many = Array.from({ length: 500 }, (_, i) => E(`f${String(i).padStart(3, '0')}.ts`));
  const out = buildHints(many, { prefix: '', rebuild: '' });
  assert.equal(out.length, HINT_LIMIT);
  assert.equal(out[0]!.value, '@f000.ts', 'and it is the first alphabetically, not a random slice');
});

test('a prefix matching nothing gives an empty list, not everything', () => {
  assert.deepEqual(build([E('src', true)], 'zzz'), []);
});

test('each hint says whether it is a dir or a file', () => {
  const out = buildHints([E('src', true), E('x.ts')], { prefix: '', rebuild: '' });
  assert.deepEqual(out.map((h) => h.kind), ['dir', 'file']);
});
