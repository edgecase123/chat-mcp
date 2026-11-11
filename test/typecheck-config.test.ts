import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * 🛑 THE TYPECHECKER READ `src/` ONLY, SO A TEST COULD IMPORT A SYMBOL THAT
 * DOES NOT EXIST AND STILL GO GREEN. `tsx` erases types at run time, so a
 * wrong `import type` path failed nothing at all.
 *
 * These assert the CONFIG reaches the test tree. They say nothing about
 * whether it is free of errors — that is the rest of #166.
 */

const ROOT = join(import.meta.dirname, '..');

/** The resolved program, from the compiler rather than from the file's text. */
function showConfig(project: string): { files: string[]; compilerOptions: Record<string, unknown> } {
  const out = execFileSync('npx', ['tsc', '--showConfig', '-p', project], {
    cwd: ROOT,
    encoding: 'utf8',
  });

  return JSON.parse(out) as { files: string[]; compilerOptions: Record<string, unknown> };
}

/**
 * Every TypeScript file actually on disk under `test/`, so the count has a
 * denominator.
 *
 * 🛑 EVERY TS EXTENSION, NOT `.ts`. A denominator of `.ts` alone cannot see an
 * `include` narrowed by EXTENSION — `test/**\/*.ts` drops a `.tsx` file and
 * every guard below still passes. The repo already has 18 `.tsx` files under
 * `src/cli/ink/`, so an Ink component test is the next one and it lands here.
 */
const TS_FILE = /\.(ts|tsx|mts|cts)$/;

function testFilesOnDisk(dir = join(ROOT, 'test')): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);

    if (entry.isDirectory()) return testFilesOnDisk(full);

    return TS_FILE.test(entry.name) ? [full] : [];
  });
}

test('🛑 tsconfig.test.json puts the test tree in the program', () => {
  const { files } = showConfig('tsconfig.test.json');
  const inTest = files.filter((f) => relative(ROOT, join(ROOT, f)).startsWith('test/'));

  assert.ok(inTest.length > 0, 'the test config resolved no files under test/');
});

test('🛑 it reaches EVERY test file, not a narrowing subset', () => {
  const { files } = showConfig('tsconfig.test.json');
  const resolved = new Set(
    files
      .map((f) => relative(ROOT, join(ROOT, f)))
      .filter((f) => f.startsWith('test/')),
  );
  const onDisk = testFilesOnDisk().map((f) => relative(ROOT, f));
  const missing = onDisk.filter((f) => !resolved.has(f));

  assert.deepEqual(missing, [], `the test config does not reach ${missing.length} file(s) on disk`);
});

test('🛑 it still reaches src/, or a test import resolves against nothing', () => {
  const { files } = showConfig('tsconfig.test.json');
  const inSrc = files.filter((f) => relative(ROOT, join(ROOT, f)).startsWith('src/'));

  assert.ok(inSrc.length > 0, 'the test config resolved no files under src/');
});

test('🛑 rootDir is the repo root — ./src gives 100 x TS6059 and checks nothing', () => {
  const { compilerOptions } = showConfig('tsconfig.test.json');

  assert.notEqual(
    compilerOptions.rootDir,
    './src',
    'rootDir ./src makes every test file "not under rootDir" and typechecks none of them',
  );
});
