import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getCompletions } from '../../../../src/cli/ink/input/completions.js';

const ctx = {
  me: 'claude2',
  peers: ['claude1', 'pclaude', 'lee'],
  memberRooms: ['#leagues', '#gate'],
  discoverRooms: ['#planning', '#deploy'],
};

test('empty input returns no completions', () => {
  assert.deepEqual(getCompletions('', 0, ctx), []);
});

test('non-slash input returns no completions', () => {
  assert.deepEqual(getCompletions('hello', 5, ctx), []);
});

test('typing "/d" suggests /dm and /dispatch', () => {
  const c = getCompletions('/d', 2, ctx);
  const names = c.map((x) => x.value);
  assert.ok(names.includes('/dm'));
  assert.ok(names.includes('/dispatch'));
  assert.ok(!names.includes('/join'));
});

test('typing "/dm cla" suggests claude1 (not self, not #room)', () => {
  const c = getCompletions('/dm cla', 7, ctx);
  const names = c.map((x) => x.value);
  assert.deepEqual(names, ['claude1']);
});

test('typing "/dm " with no prefix suggests all peers except self', () => {
  const c = getCompletions('/dm ', 4, ctx);
  const names = c.map((x) => x.value);
  assert.deepEqual(names, ['claude1', 'pclaude', 'lee']);
});

test('typing "/join #le" suggests un-joined rooms only', () => {
  const c = getCompletions('/join #le', 9, ctx);
  const names = c.map((x) => x.value);
  assert.deepEqual(names, []); // #leagues is already joined; no others match "le"
});

test('typing "/join #p" suggests #planning', () => {
  const c = getCompletions('/join #p', 8, ctx);
  const names = c.map((x) => x.value);
  assert.deepEqual(names, ['#planning']);
});

test('typing "/broadcast #g" suggests joined rooms only', () => {
  const c = getCompletions('/broadcast #g', 13, ctx);
  const names = c.map((x) => x.value);
  assert.deepEqual(names, ['#gate']);
});

test('typing "/alert #le" (room mode) suggests joined rooms only', () => {
  const c = getCompletions('/alert #le', 10, ctx);
  const names = c.map((x) => x.value);
  assert.deepEqual(names, ['#leagues']);
});

test('typing "/alert cla" (peer mode) suggests peers only', () => {
  const c = getCompletions('/alert cla', 10, ctx);
  const names = c.map((x) => x.value);
  assert.deepEqual(names, ['claude1']);
});
