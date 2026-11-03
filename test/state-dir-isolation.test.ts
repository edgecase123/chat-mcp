import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

/**
 * 🛑 THE SUITE WROTE INTO THE OPERATOR'S LIVE STATE DIRECTORY, EVERY RUN.
 *
 * Two of fifty test files called `startSupervisor` without redirecting
 * `CHAT_MCP_HOME`, so each run bound a socket under the real `~/.chat-mcp/sock`
 * and left MCP config behind. 3534 files had accumulated.
 *
 * ⚠️ `bind()` UNLINKS what it probes as a stale socket, and a live supervisor
 * that is merely slow to answer looks the same as debris. So the hazard is not
 * only litter — a dev-tree test can silence a running agent.
 *
 * Convention could not hold this. A guard can.
 */

/**
 * Importing any of these puts the caller on a path that resolves `stateDir()`.
 *
 * 🛑 MATCHED IN IMPORT STATEMENTS ONLY, NEVER IN THE FILE BODY. A body-wide
 * grep for `startSupervisor` flagged `test/storage/prune-agents.test.ts`, whose
 * only mention is a regex literal asserting a harness script still calls it.
 */
const STATE_TOUCHING = [
  'startSupervisor',
  'NotifyBus',
  'WakeListener',
  'ensureStateDir',
  'ensureNotifyDir',
  'ensureMcpConfigDir',
  'ensureAdaptersDir',
  'writeClaudeMcpConfig',
  'registerProject',
  'unregisterProject',
  'deliverToSupervisor',
];

/** Names bound by a static `import {}` or a `const {} = await import()`. */
function importedNames(src: string): Set<string> {
  const names = new Set<string>();
  const patterns = [/import\s*\{([^}]*)\}\s*from/g, /\{([^}]*)\}\s*=\s*await\s+import/g];
  for (const re of patterns) {
    for (const m of src.matchAll(re)) {
      for (const raw of (m[1] ?? '').split(',')) {
        const name = raw.replace(/\btype\b/, '').split(/\s+as\s+/)[0]?.trim();
        if (name) names.add(name);
      }
    }
  }

  return names;
}

function touchesStateDir(src: string): string[] {
  const imported = importedNames(src);
  const hits = STATE_TOUCHING.filter((n) => imported.has(n));
  // `openDb()` with no argument opens the DEFAULT path; with one it does not.
  if (imported.has('openDb') && /openDb\(\s*\)/.test(src)) hits.push('openDb()');

  return hits;
}

/**
 * 🛑 AN ASSIGNMENT, NOT A MENTION. The first version asked only whether the
 * source contained `CHAT_MCP_HOME`, and two COMMENTS naming it satisfied that.
 * Probed on `state-dir-children-perms.test.ts`: deleting its real assignment
 * left the guard green, because lines 7 and 111 talk about the variable.
 */
function redirectsStateDir(src: string): boolean {
  return REDIRECT.test(src);
}

/**
 * ⚠️ AND NOT TOO NARROW EITHER. The first assignment-only version missed
 * bracket access and the logical-assignment operators, so a legitimate redirect
 * would have been reported as an offender. Raised by claude2.
 *
 * `(?!=)` after the `=` is what keeps a COMPARISON out: `===` and `==` are
 * reads, not redirects.
 */
const REDIRECT =
  /process\.env(?:\.CHAT_MCP_HOME|\[\s*['"`]CHAT_MCP_HOME['"`]\s*\])\s*(?:\|\||\?\?)?=(?!=)/;

function testFiles(): string[] {
  return execFileSync('git', ['ls-files', 'test'], { encoding: 'utf8' })
    .split('\n')
    .filter((f) => f.endsWith('.test.ts'));
}

test('🚨 every test that can resolve a state path redirects CHAT_MCP_HOME', () => {
  const files = testFiles();
  // Denominator: a listing that matched nothing would otherwise pass.
  assert.ok(files.length >= 40, `found only ${files.length} test files`);

  const offenders: string[] = [];
  let examined = 0;
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    const hits = touchesStateDir(src);
    if (hits.length === 0) continue;
    examined += 1;
    if (!redirectsStateDir(src)) offenders.push(`${f} (via ${hits.join(', ')})`);
  }

  // The scan read real content, not empty strings.
  assert.ok(examined >= 5, `only ${examined} of ${files.length} files reach a state path`);
  assert.deepEqual(offenders, [], `these write into the operator's live ~/.chat-mcp: ${offenders.join('; ')}`);
});

/**
 * 🛑 THE MATCHER PROVES ITSELF. An empty offender list and a broken matcher
 * produce the same green, and the two real offenders were found by hand.
 */
test('🚨 the matcher catches the shapes it is looking for, and not a body mention', () => {
  assert.deepEqual(
    touchesStateDir("import { startSupervisor } from '../../src/supervise/index.js';"),
    ['startSupervisor'],
    'a static import must be caught',
  );
  assert.deepEqual(
    touchesStateDir("const { startSupervisor } = await import('../../src/supervise/index.js');"),
    ['startSupervisor'],
    'a dynamic import must be caught',
  );
  assert.deepEqual(
    touchesStateDir("assert.match(src, /startSupervisor\\(\\{/, 'still starts one');"),
    [],
    'a BODY mention is not an import — this is the false positive that cost a scan',
  );
  assert.deepEqual(
    touchesStateDir("import { openDb } from '../db.js';\nopenDb();"),
    ['openDb()'],
    'a no-argument openDb opens the default path',
  );
  assert.deepEqual(
    touchesStateDir("import { openDb } from '../db.js';\nopenDb(path);"),
    [],
    'openDb with an explicit path does not',
  );
  assert.deepEqual(
    touchesStateDir("import type { AgentChild } from '../child.js';"),
    [],
    'a type-only import reaches nothing at runtime',
  );
});

/**
 * 🛑 THE REDIRECT CHECK PROVES ITSELF TOO, AND THIS IS THE ONE THAT WAS WRONG.
 * A comment naming the variable is not a redirect, and the first version of
 * this guard accepted one.
 */
test('🚨 a COMMENT naming CHAT_MCP_HOME is not a redirect', () => {
  assert.equal(redirectsStateDir('// Point CHAT_MCP_HOME at a scratch dir first.'), false);
  assert.equal(redirectsStateDir(' * `CHAT_MCP_HOME` cannot stop it, because...'), false);
  assert.equal(redirectsStateDir('const x = process.env.CHAT_MCP_HOME;'), false, 'a READ is not a write');
  assert.equal(
    redirectsStateDir("if (process.env.CHAT_MCP_HOME === 'x') {"),
    false,
    'a COMPARISON is not a write — this is what (?!=) is for',
  );
});

/**
 * 🛑 THE OTHER DIRECTION. A matcher too narrow reports a legitimate redirect as
 * an offender, which is a false alarm on a guard people are meant to trust.
 */
test('🚨 every legitimate way of setting it is accepted', () => {
  for (const form of [
    "process.env.CHAT_MCP_HOME = '/tmp/x';",
    'process.env.CHAT_MCP_HOME  =  join(a, b);',
    "process.env['CHAT_MCP_HOME'] = '/tmp/x';",
    'process.env["CHAT_MCP_HOME"] = dir;',
    'process.env[`CHAT_MCP_HOME`] = dir;',
    "process.env.CHAT_MCP_HOME ||= '/tmp/x';",
    "process.env.CHAT_MCP_HOME ??= '/tmp/x';",
    "process.env[ 'CHAT_MCP_HOME' ] = x;",
  ]) {
    assert.equal(redirectsStateDir(form), true, `rejected a real redirect: ${form}`);
  }
});
