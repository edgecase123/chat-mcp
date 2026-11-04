import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { partitionNotifyFiles, planNotifyRemoval, isSafeHandleName, ORPHAN_UNCHECKED } from '../../src/util/notify-orphans.js';

/**
 * 🛑 A NOTIFY FILE IS DELETED WITH NO WAY TO UNDO IT, AND BEING WRONG IS SILENT.
 *
 * `fs.watch` on a removed path stops delivering and reports nothing, which is
 * why the wake Monitor watches the directory instead. So a removal that is
 * wrong about liveness does not crash — it produces an agent that looks idle
 * forever (#78). Every decision therefore lives in this pure module, where it
 * can be tested without a filesystem.
 */

test('a file with no agents row is an orphan, and one with a row is not', () => {
  const r = partitionNotifyFiles(['claude1', 'e2e-37849', 'cap-3750'], ['claude1', 'lee']);

  assert.deepEqual(r.orphans, ['cap-3750', 'e2e-37849']);
  assert.deepEqual(r.attached, ['claude1']);
});

test('🛑 the report names BOTH totals, so a count is never read without its denominator', () => {
  // The ticket's own figure is "49 of 53". A function returning only the
  // orphan list invites that 49 being quoted with no 53 beside it.
  const r = partitionNotifyFiles(['a', 'b', 'c'], ['a']);

  assert.equal(r.total, 3);
  assert.equal(r.registered, 1);
  assert.equal(r.orphans.length + r.attached.length, r.total);
});

test('orphans come back sorted, because the operator pastes them back as arguments', () => {
  const r = partitionNotifyFiles(['zed', 'alpha', 'mid'], []);

  assert.deepEqual(r.orphans, ['alpha', 'mid', 'zed']);
});

test('a registered handle with no file is not reported as anything', () => {
  // It is not an orphan and there is nothing to unlink. Reporting it would
  // read as a defect in a directory that is correct.
  const r = partitionNotifyFiles(['claude1'], ['claude1', 'never-woke']);

  assert.deepEqual(r.orphans, []);
  assert.deepEqual(r.attached, ['claude1']);
  assert.equal(r.total, 1);
});

test('🛑 a name that could escape the notify directory is refused, always', () => {
  // The orphan list comes from readdir and is safe. These come from argv.
  assert.equal(isSafeHandleName('claude2'), true);
  assert.equal(isSafeHandleName('e2e-37849'), true);
  assert.equal(isSafeHandleName('lee-approvals'), true);

  assert.equal(isSafeHandleName('../chat.db'), false);
  assert.equal(isSafeHandleName('a/b'), false);
  assert.equal(isSafeHandleName('a\\b'), false);
  assert.equal(isSafeHandleName('.'), false);
  assert.equal(isSafeHandleName('..'), false);
  assert.equal(isSafeHandleName(''), false);
});

test('an offline registered handle has its file removed alongside its row', () => {
  const plan = planNotifyRemoval({
    names: ['e2e-old'],
    files: ['e2e-old'],
    registered: ['e2e-old'],
    online: [],
    force: false,
  });

  assert.deepEqual(plan, [{ handle: 'e2e-old', unlink: true, reason: 'offline-row' }]);
});

test('🛑 an ONLINE handle keeps its file, because removing it silences the agent', () => {
  const plan = planNotifyRemoval({
    names: ['claude1'],
    files: ['claude1'],
    registered: ['claude1'],
    online: ['claude1'],
    force: false,
  });

  assert.deepEqual(plan, [{ handle: 'claude1', unlink: false, reason: 'online' }]);
});

test('--force removes an online handle, which is the whole point of the flag', () => {
  const plan = planNotifyRemoval({
    names: ['stuck'],
    files: ['stuck'],
    registered: ['stuck'],
    online: ['stuck'],
    force: true,
  });

  assert.deepEqual(plan, [{ handle: 'stuck', unlink: true, reason: 'forced' }]);
});

/**
 * 🛑 THIS IS THE CASE THE TICKET'S OWN `## Proposed` COULD NOT REACH.
 *
 * It proposed deleting the file "alongside its `agents` row". All 49 orphans
 * have NO row, so `partitionPrunable` calls them `absent` and the script does
 * nothing. The existing litter needed its own path, and that path cannot
 * check liveness — so it says so rather than implying it did.
 */
test('🛑 an orphan with no row is removable, and its reason says liveness was UNCHECKED', () => {
  const plan = planNotifyRemoval({
    names: ['e2e-37849'],
    files: ['e2e-37849'],
    registered: [],
    online: [],
    force: false,
  });

  assert.deepEqual(plan, [{ handle: 'e2e-37849', unlink: true, reason: 'orphan-liveness-unchecked' }]);
});

test('a named handle with no file at all is reported, not silently skipped', () => {
  // A typo must not read as success. Same rule the agents half already follows.
  const plan = planNotifyRemoval({
    names: ['typo'],
    files: ['claude1'],
    registered: ['claude1'],
    online: [],
    force: false,
  });

  assert.deepEqual(plan, [{ handle: 'typo', unlink: false, reason: 'no-file' }]);
});

test('🛑 an unsafe name is refused even when it names a real file', () => {
  const plan = planNotifyRemoval({
    names: ['../chat.db'],
    files: ['../chat.db'],
    registered: [],
    online: [],
    force: false,
  });

  assert.deepEqual(plan, [{ handle: '../chat.db', unlink: false, reason: 'unsafe-name' }]);
});

test('--force does not override the unsafe-name refusal', () => {
  // The liveness guard has an override and this one must not, which is the
  // same split prune-test-agents.mjs already draws for prefixes.
  const plan = planNotifyRemoval({
    names: ['a/b'],
    files: ['a/b'],
    registered: [],
    online: [],
    force: true,
  });

  assert.deepEqual(plan, [{ handle: 'a/b', unlink: false, reason: 'unsafe-name' }]);
});

test('a plan keeps one entry per NAME, in the order given', () => {
  const plan = planNotifyRemoval({
    names: ['zed', 'claude1', 'gone'],
    files: ['zed', 'claude1'],
    registered: ['claude1'],
    online: ['claude1'],
    force: false,
  });

  assert.deepEqual(
    plan.map((p) => [p.handle, p.unlink]),
    [
      ['zed', true],
      ['claude1', false],
      ['gone', false],
    ],
  );
});

/**
 * 🛑 THE COPY IS THE SAFETY FEATURE, so it is tested like one.
 *
 * claude1 on PR 114: list mode said *"those handles are gone, so there is no
 * liveness to check"*. That IS a liveness claim, printed in the one place a
 * human reads BEFORE deciding to delete, while the removal path four lines
 * later correctly said liveness was unchecked.
 */
test('🛑 the orphan sentence never claims a handle is gone, dead or safe', () => {
  assert.match(ORPHAN_UNCHECKED, /no agent row/i, 'it has to say what IS known');
  assert.match(ORPHAN_UNCHECKED, /NOT proof/i, 'and that the known part proves nothing');
  assert.match(ORPHAN_UNCHECKED, /nothing here can check/i);

  for (const claim of [/\bare gone\b/i, /\bis gone\b/i, /\bno liveness to check\b/i, /\bsafe to\b/i, /\bnot running\b/i]) {
    assert.doesNotMatch(ORPHAN_UNCHECKED, claim, `the sentence asserts ${claim}`);
  }
});

test('both operator paths print the SAME sentence, so they cannot drift', () => {
  const script = readFileSync(new URL('../../scripts/prune-test-agents.mjs', import.meta.url), 'utf8');

  // Two call sites, one constant. The first draft had two hand-written
  // sentences and they disagreed with each other.
  assert.equal(
    (script.match(/ORPHAN_UNCHECKED/g) ?? []).length,
    3,
    'expected the import plus both call sites to use the one constant',
  );
  assert.doesNotMatch(script, /handles are gone/i, 'the liveness claim is back in the script');
});
