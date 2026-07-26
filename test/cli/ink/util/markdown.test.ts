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
