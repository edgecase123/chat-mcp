import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fuzzyMatch, fuzzyFilter } from '../../../src/cli/ink/fuzzy.js';

test('empty query matches everything', () => {
  assert.equal(fuzzyMatch('', 'anything'), true);
});

test('exact prefix matches', () => {
  assert.equal(fuzzyMatch('dm', '/dm'), true);
});

test('subsequence match', () => {
  assert.equal(fuzzyMatch('dsp', '/dispatch'), true);
  assert.equal(fuzzyMatch('brd', '/broadcast'), true);
});

test('missing letters do not match', () => {
  assert.equal(fuzzyMatch('xyz', '/dispatch'), false);
});

test('case-insensitive', () => {
  assert.equal(fuzzyMatch('DM', '/dm'), true);
  assert.equal(fuzzyMatch('dm', '/DM'), true);
});

test('fuzzyFilter returns matches in input order', () => {
  const items = ['/dm', '/dispatch', '/join', '/broadcast'];
  const result = fuzzyFilter('d', items, (s) => s);
  assert.deepEqual(result, ['/dm', '/dispatch', '/broadcast']);
});
