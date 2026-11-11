import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeSpawn } from '../../src/adapters/claude-spawn.js';
import { supervisorOptions } from './supervisor-options.js';

/**
 * 🛑 `SupervisorOptions.vendor` IS REQUIRED AND STAYS REQUIRED. lee ruled the
 * fix for #166's 26 test-side errors is a factory, not a loosened production
 * type — relaxing a real contract to quiet a test moves the defect into
 * production.
 *
 * These assert the factory supplies the ONE field it is for and nothing else.
 */

test('🛑 it supplies the vendor a caller would otherwise have to name', () => {
  const opts = supervisorOptions({ handle: 'h1' });

  assert.equal(opts.vendor, claudeSpawn);
});

/**
 * 🛑 THE REAL VENDOR, NOT A STUB. The 26 call sites pass `spawnChild`, so
 * `opts.vendor` is only read on the default-spawn and redispatch paths
 * (`supervise/index.ts:249`, `:670`). A stub would make those two paths behave
 * unlike production exactly where a test did reach them.
 */
test('🛑 the default is the REAL claudeSpawn, so a reached path behaves like production', () => {
  const opts = supervisorOptions({ handle: 'h1' });

  assert.equal(typeof opts.vendor.redispatchPrompt, 'function');
  assert.equal(opts.vendor.binary, claudeSpawn.binary);
});

test("a caller's own vendor wins over the default", () => {
  const mine = { ...claudeSpawn, binary: 'not-claude' };
  const opts = supervisorOptions({ handle: 'h1', vendor: mine });

  assert.equal(opts.vendor, mine);
});

/**
 * 🛑 THE FACTORY ADDS EXACTLY ONE KEY. A factory that defaulted `handle`, `db`
 * or `extraDirs` too would launder those contracts as well, and a test that
 * forgot one would go green against a default it never chose.
 */
test('🛑 it adds `vendor` and NOTHING else — every other field stays the caller’s', () => {
  const given = { handle: 'h1', extraDirs: ['/tmp'] as readonly string[] };
  const opts = supervisorOptions(given);
  const added = Object.keys(opts).filter((k) => !Object.hasOwn(given, k));

  assert.deepEqual(added, ['vendor']);
});

test('it passes every field the caller did give straight through', () => {
  const log = () => undefined;
  const opts = supervisorOptions({ handle: 'h1', driver: 'claude', reply: false, log });

  assert.equal(opts.handle, 'h1');
  assert.equal(opts.driver, 'claude');
  assert.equal(opts.reply, false);
  assert.equal(opts.log, log);
});
