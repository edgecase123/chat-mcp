import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { KNOWN_SUBCOMMANDS } from '../../src/util/subcommands.js';

/**
 * 🛑 A verb registered with commander but missing from KNOWN_SUBCOMMANDS does
 * NOT error. It falls through to MCP shim mode and complains about a missing
 * --handle, which looks like a bad invocation rather than a missing entry.
 *
 * Read from the source text rather than by importing src/index.ts, because
 * that module runs the CLI on import.
 */
test('every commander verb is also in KNOWN_SUBCOMMANDS', () => {
  const source = readFileSync(new URL('../../src/index.ts', import.meta.url), 'utf8');
  const registered = [...source.matchAll(/\.command\('([^'\s<[]+)/g)].map((m) => m[1]!);

  assert.ok(registered.length > 10, `expected to find the verbs, found ${registered.length}`);

  const missing = registered.filter((v) => !KNOWN_SUBCOMMANDS.has(v));

  assert.deepEqual(missing, [], `these verbs fall through to shim mode: ${missing.join(', ')}`);
});

test('supervise is registered and reachable', () => {
  const source = readFileSync(new URL('../../src/index.ts', import.meta.url), 'utf8');

  assert.ok(source.includes(".command('supervise"), 'the verb is not registered');
  assert.ok(KNOWN_SUBCOMMANDS.has('supervise'), 'the verb would fall through to shim mode');
});
