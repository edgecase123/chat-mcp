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

function renderToken(t: Token): string {
  switch (t.kind) {
    case 'text':
      return escapeHtml(t.value).replace(/\n/g, '<br>');
    case 'bold':
      return `<strong>${escapeHtml(t.value)}</strong>`;
    case 'italic':
      return `<em>${escapeHtml(t.value)}</em>`;
    case 'code':
      return `<code class="inline">${escapeHtml(t.value)}</code>`;
    case 'code-block':
      return `<pre><code>${escapeHtml(t.value)}</code></pre>`;
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
