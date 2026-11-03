import stringWidth from 'string-width';

/**
 * Hard word-wrap `body` at `cols` columns, respecting existing newlines.
 * Words longer than `cols` are hard-broken mid-word so no line exceeds the
 * budget. Preserves whitespace runs where possible.
 *
 * Owns the wrap so we don't have to trust the Ink Text-wrap-inside-a-Box
 * chain — that chain works in headless renders but has failed in some
 * live-terminal setups where content bleeds past the pane border.
 */
/**
 * Some senders (agents that build messages from JSON-stringified templates,
 * or copy-paste from escaped source) deliver bodies with literal `\n`
 * two-char sequences instead of real newline bytes. The message then
 * renders as one long line with visible `\n` markers. Detect + rehydrate:
 * if the body contains ANY `\n` escape and NO real newlines, treat the
 * escapes as newlines. Also handles `\r\n` and `\t` while we're here.
 * Bodies that mix real newlines with literal `\n` are left alone — that
 * ambiguity is likely intentional (e.g. discussing the `\n` character in
 * a code snippet).
 */
export function rehydrateEscapedNewlines(body: string): string {
  if (body.includes('\n')) return body;
  if (!body.includes('\\n') && !body.includes('\\t') && !body.includes('\\r')) return body;
  return body
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\n')
    .replace(/\\t/g, '\t');
}

export function wrapBody(body: string, cols: number): string {
  const budget = Math.max(1, Math.floor(cols));
  return body.split('\n').map((line) => {
    // Preserve markdown table rows verbatim so the Markdown tokenizer can
    // recognize them — wrapping at whitespace would split rows mid-line and
    // break the pipe count. Table row: starts + ends with `|`. Includes
    // separator rows like `|---|---|`. Table renderer compresses widths
    // downstream to fit the pane, so leaving these lines long is safe.
    if (/^\s*\|.*\|\s*$/.test(line)) return line;
    return wrapLine(line, budget);
  }).join('\n');
}

/**
 * Count how many terminal rows `body` will occupy when wrapped at `cols`.
 * Uses the same wrap algorithm as `wrapBody` so callers can budget
 * viewport space accurately — a char-count approximation (`ceil(len/cols)`)
 * under-counts by 15-25% because real wrap only breaks at whitespace and
 * short trailing words push wraps forward.
 */
export function wrappedRowCount(body: string, cols: number): number {
  if (body.length === 0) return 1;
  return wrapBody(body, cols).split('\n').length;
}

/**
 * The longest prefix of `t` whose DISPLAY width fits `cols`.
 *
 * 🛑 ITERATES BY CODE POINT, so a surrogate pair is never split in half. A
 * `slice(0, cols)` both over-ran the budget on wide glyphs and could cut an
 * emoji into two broken halves.
 */
function sliceToWidth(t: string, cols: number): string {
  let out = '';
  for (const ch of t) {
    if (stringWidth(out + ch) > cols) break;
    out += ch;
  }

  return out;
}

/** The first code point, for the case where one glyph alone exceeds the budget. */
function firstCodePoint(t: string): string {
  return [...t][0] ?? '';
}

function wrapLine(line: string, cols: number): string {
  if (stringWidth(line) <= cols) return line;
  const out: string[] = [];
  let cur = '';
  // Split on whitespace but KEEP the whitespace runs so we can restore them.
  const parts = line.split(/(\s+)/);
  for (const part of parts) {
    if (part.length === 0) continue;
    // A too-long single token — hard-break.
    if (stringWidth(part) > cols) {
      if (cur) { out.push(cur); cur = ''; }
      let remaining = part;
      while (stringWidth(remaining) > cols) {
        // 🛑 A GLYPH WIDER THAN THE WHOLE BUDGET CANNOT BE SPLIT. Emitting it
        // alone overruns by design; an empty head here would loop forever.
        const head = sliceToWidth(remaining, cols) || firstCodePoint(remaining);
        out.push(head);
        remaining = remaining.slice(head.length);
      }
      cur = remaining;
      continue;
    }
    if (stringWidth(cur + part) > cols) {
      out.push(cur.trimEnd());
      cur = /^\s/.test(part) ? '' : part;
    } else {
      cur += part;
    }
  }
  if (cur) out.push(cur);
  return out.join('\n');
}
