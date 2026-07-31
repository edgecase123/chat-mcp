import { test } from 'node:test';
import assert from 'node:assert/strict';
import React, { useState } from 'react';
import { render } from 'ink-testing-library';
import { Input } from '../../../../src/cli/ink/input/Input.js';

/** Test harness — hosts the Input in a controlled component so we can observe
 *  value transitions and submits without touching real terminal state. */
function makeHarness(): {
  Wrapper: React.FC;
  getValue: () => string;
  submits: string[];
} {
  const state = { value: '', cursor: 0 };
  const submits: string[] = [];
  const Wrapper: React.FC = () => {
    const [tick, setTick] = useState(0);
    return React.createElement(Input, {
      value: state.value,
      cursor: state.cursor,
      onChange: (v: string, c: number) => { state.value = v; state.cursor = c; setTick(tick + 1); },
      onSubmit: (v: string) => { submits.push(v); state.value = ''; state.cursor = 0; setTick(tick + 1); },
    });
  };
  return { Wrapper, getValue: () => state.value, submits };
}

test('Ctrl-J (raw \\n) inserts a newline instead of submitting', async () => {
  const h = makeHarness();
  const { stdin, unmount } = render(React.createElement(h.Wrapper));
  await new Promise((r) => setTimeout(r, 10));
  stdin.write('a'); await new Promise((r) => setTimeout(r, 10));
  stdin.write('\n'); await new Promise((r) => setTimeout(r, 10)); // Ctrl-J
  stdin.write('b'); await new Promise((r) => setTimeout(r, 10));
  assert.equal(h.getValue(), 'a\nb', 'newline should be inserted, not submitted');
  assert.equal(h.submits.length, 0, 'no submission on Ctrl-J');
  unmount();
});

test('plain Enter (\\r) still submits and clears', async () => {
  const h = makeHarness();
  const { stdin, unmount } = render(React.createElement(h.Wrapper));
  await new Promise((r) => setTimeout(r, 10));
  stdin.write('x'); await new Promise((r) => setTimeout(r, 10));
  stdin.write('y'); await new Promise((r) => setTimeout(r, 10));
  stdin.write('\r'); await new Promise((r) => setTimeout(r, 10)); // Enter
  assert.deepEqual(h.submits, ['xy'], 'plain Enter should submit the buffer');
  assert.equal(h.getValue(), '', 'buffer should clear after submit');
  unmount();
});

test('Opt-Enter (ESC + \\r) inserts newline instead of submitting', async () => {
  const h = makeHarness();
  const { stdin, unmount } = render(React.createElement(h.Wrapper));
  await new Promise((r) => setTimeout(r, 10));
  stdin.write('h'); await new Promise((r) => setTimeout(r, 10));
  stdin.write('i'); await new Promise((r) => setTimeout(r, 10));
  stdin.write('\x1b\r'); await new Promise((r) => setTimeout(r, 10)); // Opt-Enter
  stdin.write('!'); await new Promise((r) => setTimeout(r, 10));
  assert.equal(h.getValue(), 'hi\n!', 'Opt-Enter should insert newline');
  assert.equal(h.submits.length, 0, 'no submission on Opt-Enter');
  unmount();
});
