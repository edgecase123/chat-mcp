import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rehydrateEscapedNewlines } from '../../src/util/wrap.js';

test('body with real newlines is left untouched', () => {
  const body = 'line one\nline two\nline three';
  assert.equal(rehydrateEscapedNewlines(body), body);
});

test('body with only escaped \\n gets rehydrated', () => {
  const body = 'line one\\nline two\\nline three';
  assert.equal(rehydrateEscapedNewlines(body), 'line one\nline two\nline three');
});

test('body without any newline markers is untouched', () => {
  const body = 'just one long sentence with nothing to escape';
  assert.equal(rehydrateEscapedNewlines(body), body);
});

test('mixed real + escaped newlines: leave alone (ambiguous)', () => {
  // If someone genuinely writes about `\n` in a message that already has
  // real newlines, we can't tell intent. Leave it.
  const body = 'first real line\nsecond line mentions \\n as a chunk';
  assert.equal(rehydrateEscapedNewlines(body), body);
});

test('rehydrates \\r\\n (CRLF), \\r, and \\t', () => {
  const body = 'a\\r\\nb\\rc\\td';
  assert.equal(rehydrateEscapedNewlines(body), 'a\nb\nc\td');
});

test('rehydrates the shape seen in the wild: `text\\n\\n- bullet`', () => {
  const body = 'existing work:\\n-  8882efa  Fix\\n\\nnext paragraph';
  const out = rehydrateEscapedNewlines(body);
  assert.equal(out, 'existing work:\n-  8882efa  Fix\n\nnext paragraph');
});
