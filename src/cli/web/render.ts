import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import json from 'highlight.js/lib/languages/json';
import php from 'highlight.js/lib/languages/php';
import python from 'highlight.js/lib/languages/python';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import { tokenize, type Token } from '../ink/util/markdown.js';
import { rehydrateEscapedNewlines } from '../../util/wrap.js';

/**
 * Server-side markdown → safe HTML. Reuses the same tokenizer the Ink UI
 * uses so both surfaces agree on parse rules (bold, italic, code, links,
 * fenced code blocks, GitHub-flavour tables).
 *
 * Every dynamic value passes through `escapeHtml` so a hostile body
 * cannot inject markup. URLs additionally get scheme-checked so a
 * `javascript:` link can't turn into a live event handler.
 */

const ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESCAPE_MAP[c]!);
}

/** Only allow http(s), mailto, and relative URLs. Anything else (javascript:,
 *  data:, etc.) becomes `#` so it's a dead link. */
function safeUrl(raw: string): string {
  const trimmed = raw.trim();
  if (/^(https?:|mailto:)/i.test(trimmed)) return trimmed;
  if (/^[\/#?]/.test(trimmed)) return trimmed;
  return '#';
}

// Registered explicitly rather than importing the full bundle: this runs in
// a local dev tool and the full grammar set is an order of magnitude larger
// than the ten people here actually paste.
for (const [name, lang] of Object.entries({
  bash, css, diff, json, php, python, sql, typescript, xml, yaml,
})) {
  hljs.registerLanguage(name, lang);
}
hljs.registerAliases(['sh', 'shell', 'zsh'], { languageName: 'bash' });
hljs.registerAliases(['js', 'jsx', 'ts', 'tsx', 'javascript'], { languageName: 'typescript' });
hljs.registerAliases(['html', 'svg'], { languageName: 'xml' });
hljs.registerAliases(['yml'], { languageName: 'yaml' });

/**
 * 🛑 THE ONLY PLACE UNESCAPED HTML IS EMITTED. highlight.js escapes the code
 * it wraps, which is why its output can go in raw. An unknown language falls
 * back to escapeHtml, so a body is never interpolated unescaped on any path.
 */
function renderCode(value: string, lang: string | undefined): string {
  if (lang === undefined || !hljs.getLanguage(lang)) return escapeHtml(value);
  try {
    const { value: html } = hljs.highlight(value, { language: lang, ignoreIllegals: true });
    return html;
  } catch {
    return escapeHtml(value);
  }
}

// A bare URL, stopping before trailing sentence punctuation so "see
// https://example.com/x." does not link the full stop. A closing bracket is
// kept only when the URL opened one.
const BARE_URL = /https?:\/\/[^\s<>"']+/g;

function trimUrlTail(url: string): string {
  let end = url.length;
  while (end > 0) {
    const ch = url[end - 1]!;
    if ('.,;:!?'.includes(ch)) { end -= 1; continue; }
    if (ch === ')' && !url.slice(0, end).includes('(')) { end -= 1; continue; }
    break;
  }
  return url.slice(0, end);
}

/**
 * Escape, then turn bare URLs into links. Runs on TEXT tokens only, so a URL
 * inside a code block or an existing [label](url) is never touched — those
 * are separate tokens by the time this is called.
 */
function renderText(value: string): string {
  let out = '';
  let last = 0;
  for (const m of value.matchAll(BARE_URL)) {
    const raw = trimUrlTail(m[0]);
    const start = m.index!;
    out += escapeHtml(value.slice(last, start)).replace(/\n/g, '<br>');
    out += `<a href="${escapeHtml(safeUrl(raw))}" target="_blank" rel="noopener noreferrer">${escapeHtml(raw)}</a>`;
    last = start + raw.length;
  }
  out += escapeHtml(value.slice(last)).replace(/\n/g, '<br>');

  return out;
}

function renderToken(t: Token): string {
  switch (t.kind) {
    case 'text':
      return renderText(t.value);
    case 'bold':
      return `<strong>${escapeHtml(t.value)}</strong>`;
    case 'italic':
      return `<em>${escapeHtml(t.value)}</em>`;
    case 'code':
      return `<code class="inline">${escapeHtml(t.value)}</code>`;
    case 'code-block': {
      const cls = t.lang === undefined ? 'hljs' : `hljs language-${escapeHtml(t.lang)}`;
      return `<pre><code class="${cls}">${renderCode(t.value, t.lang)}</code></pre>`;
    }
    case 'link':
      return `<a href="${escapeHtml(safeUrl(t.url))}" target="_blank" rel="noopener noreferrer">${escapeHtml(t.label)}</a>`;
    case 'table': {
      const header = t.header.map((h) => `<th>${escapeHtml(h)}</th>`).join('');
      const rows = t.rows
        .map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(c ?? '')}</td>`).join('')}</tr>`)
        .join('');
      return `<table><thead><tr>${header}</tr></thead><tbody>${rows}</tbody></table>`;
    }
  }
}

/** Public entry: rehydrate any escaped newlines from senders that JSON-stringify
 *  their bodies, then tokenize + serialize to HTML. */
export function renderBodyToHtml(body: string): string {
  const clean = rehydrateEscapedNewlines(body);
  const tokens = tokenize(clean);
  return tokens.map(renderToken).join('');
}
