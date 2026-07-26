import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize } from '../../../../src/cli/ink/util/markdown.js';

test('plain text tokenizes to a single text token', () => {
  assert.deepEqual(tokenize('hello world'), [{ kind: 'text', value: 'hello world' }]);
});

test('bold: **foo**', () => {
  assert.deepEqual(tokenize('a **b** c'), [
    { kind: 'text', value: 'a ' },
    { kind: 'bold', value: 'b' },
    { kind: 'text', value: ' c' },
  ]);
});

test('italic: *foo*', () => {
  assert.deepEqual(tokenize('*foo*'), [{ kind: 'italic', value: 'foo' }]);
});

test('inline code: `foo`', () => {
  assert.deepEqual(tokenize('run `npm test` please'), [
    { kind: 'text', value: 'run ' },
    { kind: 'code', value: 'npm test' },
    { kind: 'text', value: ' please' },
  ]);
});

test('link: [label](url)', () => {
  assert.deepEqual(tokenize('see [docs](https://example.com)'), [
    { kind: 'text', value: 'see ' },
    { kind: 'link', label: 'docs', url: 'https://example.com' },
  ]);
});

test('fenced code block (multi-line form)', () => {
  assert.deepEqual(tokenize('before\n```\nfoo\nbar\n```\nafter'), [
    { kind: 'text', value: 'before\n' },
    { kind: 'code-block', value: 'foo\nbar' },
    { kind: 'text', value: '\nafter' },
  ]);
});

test('fenced code block (inline form — CLI input cannot carry newlines)', () => {
  assert.deepEqual(tokenize('run ```const x = 1;``` please'), [
    { kind: 'text', value: 'run ' },
    { kind: 'code-block', value: 'const x = 1;' },
    { kind: 'text', value: ' please' },
  ]);
});

test('fenced code block with lang tag', () => {
  assert.deepEqual(tokenize('```js\nconst x = 1;\n```'), [
    { kind: 'code-block', value: 'const x = 1;' },
  ]);
});

test('escaped triggers render literal', () => {
  assert.deepEqual(tokenize('a \\*b\\* c'), [{ kind: 'text', value: 'a *b* c' }]);
});

test('unterminated bold renders literal', () => {
  assert.deepEqual(tokenize('a **b c'), [{ kind: 'text', value: 'a **b c' }]);
});

test('mixed content', () => {
  assert.deepEqual(tokenize('run **`npm test`** now'), [
    { kind: 'text', value: 'run ' },
    { kind: 'bold', value: '`npm test`' }, // nested markdown not parsed — bold takes precedence
    { kind: 'text', value: ' now' },
  ]);
});

test('table: header + separator + rows', () => {
  const input = [
    '| col1 | col2 |',
    '|------|------|',
    '| a    | b    |',
    '| c    | d    |',
  ].join('\n');
  assert.deepEqual(tokenize(input), [
    { kind: 'table', header: ['col1', 'col2'], rows: [['a', 'b'], ['c', 'd']] },
  ]);
});

test('table: text before and after', () => {
  const input = [
    'here is a table:',
    '| a | b |',
    '|---|---|',
    '| 1 | 2 |',
    'and text after',
  ].join('\n');
  assert.deepEqual(tokenize(input), [
    { kind: 'text', value: 'here is a table:\n' },
    { kind: 'table', header: ['a', 'b'], rows: [['1', '2']] },
    { kind: 'text', value: 'and text after' },
  ]);
});

test('table: separator with alignment colons still matches', () => {
  const input = '| a | b |\n| :--- | ---: |\n| 1 | 2 |';
  assert.deepEqual(tokenize(input), [
    { kind: 'table', header: ['a', 'b'], rows: [['1', '2']] },
  ]);
});

test('table: rejects when separator line is missing', () => {
  const input = '| a | b |\n| 1 | 2 |';
  const tokens = tokenize(input);
  // No separator → falls through to plain text
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0]!.kind, 'text');
});
