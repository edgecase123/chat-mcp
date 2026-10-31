import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

/**
 * 🛑 `chat-mcp --version` printed 0.3.0 while package.json said 0.4.11.
 *
 * Bumping the version is this project's way of proving a new build is the one
 * running. A hardcoded `--version` that drifts makes that proof worthless, and
 * it drifted for several releases without anything noticing.
 */
test('--version reports exactly what package.json says', () => {
  const pkg = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  ) as { version: string };

  const printed = execFileSync(
    process.execPath,
    ['--import', 'tsx', new URL('../../src/index.ts', import.meta.url).pathname, '--version'],
    { encoding: 'utf8' },
  ).trim();

  assert.equal(printed, pkg.version);
});

test('the version is not hardcoded in the source', () => {
  const source = readFileSync(new URL('../../src/index.ts', import.meta.url), 'utf8');

  // A literal passed to .version() is the drift this test exists to stop.
  assert.ok(!/\.version\('\d/.test(source), '.version() is given a literal again');
});
