import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderBodyToHtml } from '../../../src/cli/web/render.js';

/**
 * 🛑 THIS IS THE ONLY PLACE THE APP EMITS HTML IT DID NOT ESCAPE ITSELF.
 * highlight.js escapes the code it wraps, so its output goes in raw. Every
 * test that adds a highlighted path therefore also asserts that a hostile
 * body on that path is still inert.
 */

// ── fenced code blocks ───────────────────────────────────────────────────

test('a ```php block is highlighted, so the language tag is no longer discarded', () => {
  const html = renderBodyToHtml('```php\n$myvar = $this->getVar();\n```');

  assert.match(html, /class="hljs language-php"/);
  assert.match(html, /<span class="hljs-variable">\$myvar<\/span>/);
});

test('an unknown language falls back to escaped text rather than failing open', () => {
  const html = renderBodyToHtml('```nosuchlang\n<img src=x onerror=alert(1)>\n```');

  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<img/);
});

test('a hostile body inside a HIGHLIGHTED block is still inert', () => {
  const html = renderBodyToHtml('```php\n$x = "<img src=x onerror=alert(1)>";\n```');

  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});

test('a block with no language still renders, unhighlighted', () => {
  const html = renderBodyToHtml('```\nplain\n```');

  assert.match(html, /<code class="hljs">plain<\/code>/);
});

// ── links ────────────────────────────────────────────────────────────────

test('a bare URL becomes a link that opens in a new tab', () => {
  const html = renderBodyToHtml('see https://example.com/x now');

  assert.match(html, /<a href="https:\/\/example\.com\/x" target="_blank" rel="noopener noreferrer">/);
});

test('trailing sentence punctuation is not swallowed into the URL', () => {
  const html = renderBodyToHtml('go to https://example.com/x.');

  assert.match(html, /href="https:\/\/example\.com\/x"/);
  assert.match(html, /<\/a>\.$/);
});

test('a URL inside inline code is not linked', () => {
  const html = renderBodyToHtml('`https://example.com/x`');

  assert.doesNotMatch(html, /<a /);
});

test('a URL inside a code block is not linked', () => {
  const html = renderBodyToHtml('```\nhttps://example.com/x\n```');

  assert.doesNotMatch(html, /<a /);
});

test('a markdown link still opens in a new tab', () => {
  const html = renderBodyToHtml('see [docs](https://example.com/x)');

  assert.match(html, /<a href="https:\/\/example\.com\/x" target="_blank" rel="noopener noreferrer">docs<\/a>/);
});

test('a javascript: URL is defused, not linked', () => {
  const html = renderBodyToHtml('[click](javascript:alert(1))');

  assert.match(html, /href="#"/);
  assert.doesNotMatch(html, /javascript:/);
});

test('an attribute-breaking payload after a URL cannot escape the href', () => {
  const html = renderBodyToHtml('x https://e.com/"><img src=x onerror=alert(1)> y');

  assert.doesNotMatch(html, /<img/);
  assert.match(html, /href="https:\/\/e\.com\/"/);
});
