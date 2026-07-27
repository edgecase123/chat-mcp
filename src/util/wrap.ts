/**
 * Hard word-wrap `body` at `cols` columns, respecting existing newlines.
 * Words longer than `cols` are hard-broken mid-word so no line exceeds the
 * budget. Preserves whitespace runs where possible.
 *
 * Owns the wrap so we don't have to trust the Ink Text-wrap-inside-a-Box
 * chain — that chain works in headless renders but has failed in some
 * live-terminal setups where content bleeds past the pane border.
 */
export function wrapBody(body: string, cols: number): string {
  const budget = Math.max(1, Math.floor(cols));
  return body.split('\n').map((line) => wrapLine(line, budget)).join('\n');
}

function wrapLine(line: string, cols: number): string {
  if (line.length <= cols) return line;
  const out: string[] = [];
  let cur = '';
  // Split on whitespace but KEEP the whitespace runs so we can restore them.
  const parts = line.split(/(\s+)/);
  for (const part of parts) {
    if (part.length === 0) continue;
    // A too-long single token — hard-break.
    if (part.length > cols) {
      if (cur) { out.push(cur); cur = ''; }
      let remaining = part;
      while (remaining.length > cols) {
        out.push(remaining.slice(0, cols));
        remaining = remaining.slice(cols);
      }
      cur = remaining;
      continue;
    }
    if ((cur + part).length > cols) {
      out.push(cur.trimEnd());
      cur = /^\s/.test(part) ? '' : part;
    } else {
      cur += part;
    }
  }
  if (cur) out.push(cur);
  return out.join('\n');
}
