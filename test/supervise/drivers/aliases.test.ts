import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDriver } from '../../../src/supervise/drivers/index.js';

test('the published driver names keep working', () => {
  assert.deepEqual(resolveDriver({ driver: 'claude' }), { vendor: 'claude', mode: 'host' });
  assert.deepEqual(resolveDriver({ driver: 'docker-claude' }), { vendor: 'claude', mode: 'docker' });
});

test('--container with no --driver means the docker mode of the default vendor', () => {
  assert.deepEqual(resolveDriver({ container: true }), { vendor: 'claude', mode: 'docker' });
});

test('🛑 a vendor name plus --container needs no new alias', () => {
  // This is the whole point of #131: a second CLI is a file, not a branch.
  assert.deepEqual(resolveDriver({ driver: 'cursor', container: true }), {
    vendor: 'cursor',
    mode: 'docker',
  });
});

test('neither flag means the host mode of the default vendor', () => {
  assert.deepEqual(resolveDriver({}), { vendor: 'claude', mode: 'host' });
});
