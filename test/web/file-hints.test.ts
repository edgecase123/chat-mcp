import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHints, isInside, resolveHintQuery, HINT_LIMIT } from '../../src/cli/web/file-hints.js';

const ROOTS = { cwd: '/proj', home: '/home/lee' };
const q = (token: string) => resolveHintQuery(token, ROOTS);

// ── where a token resolves ──────────────────────────────────────────────

test('a bare token lists the project folder', () => {
  assert.deepEqual(q(''), { dirAbs: '/proj', prefix: '', rebuild: '' });
});

test('a relative token resolves against the project folder, never the home one', () => {
  assert.deepEqual(q('src/lo'), { dirAbs: '/proj/src', prefix: 'lo', rebuild: 'src/' });
});

test('"~/" resolves against the home directory', () => {
  assert.deepEqual(q('~/dev/le'), { dirAbs: '/home/lee/dev', prefix: 'le', rebuild: '~/dev/' });
});

test('"~" alone lists the home directory', () => {
  assert.deepEqual(q('~'), { dirAbs: '/home/lee', prefix: '', rebuild: '~/' });
});

test('the rebuild keeps the shape the user typed, so accepting does not rewrite it', () => {
  assert.equal(q('~/dev/')!.rebuild, '~/dev/', 'a tilde token stays a tilde token');
  assert.equal(q('src/')!.rebuild, 'src/', 'and a relative one stays relative');
});

// ── what it refuses ─────────────────────────────────────────────────────

test('🛑 an ABSOLUTE token is refused. There is no root to contain it.', () => {
  assert.equal(q('/etc/passwd'), null);
  assert.equal(q('/'), null);
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

test('isInside accepts the root itself and rejects a sibling with a shared prefix', () => {
  assert.equal(isInside('/proj', '/proj'), true);
  assert.equal(isInside('/proj/src', '/proj'), true);
  assert.equal(isInside('/project-other', '/proj'), false, 'a string prefix is not containment');
  assert.equal(isInside('/', '/proj'), false);
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
