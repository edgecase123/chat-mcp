import React from 'react';
import { Text } from 'ink';

export type Token =
  | { kind: 'text'; value: string }
  | { kind: 'bold'; value: string }
  | { kind: 'italic'; value: string }
  | { kind: 'code'; value: string }
  | { kind: 'code-block'; value: string }
  | { kind: 'link'; label: string; url: string }
  | { kind: 'table'; header: string[]; rows: string[][] };

const TRIGGERS = new Set(['*', '`', '[', '\\']);

/**
 * A GitHub-flavoured markdown table header separator: pipes and dashes,
 * optionally with alignment colons and whitespace. `| :--- | ---: | :---: |`
 * all match. The line must consist entirely of these characters.
 */
const TABLE_SEPARATOR_RE = /^\s*\|?(\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?\s*$/;

/** Split a table row like `| a | b | c |` into cells (trims + drops empty
 *  leading/trailing cell from surrounding pipes). */
function splitTableRow(line: string): string[] {
  const cells = line.split('|').map((c) => c.trim());
  if (cells.length > 0 && cells[0] === '') cells.shift();
  if (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
  return cells;
}

/**
 * Try to consume a table starting at line `startLineIdx` in `lines`.
 * Returns { table, linesConsumed } on success, or null if the shape doesn't
 * match (header row, separator, ≥0 body rows all starting with `|`).
 */
function tryTable(lines: string[], startLineIdx: number): { header: string[]; rows: string[][]; linesConsumed: number } | null {
  const headerLine = lines[startLineIdx];
  const sepLine = lines[startLineIdx + 1];
  if (headerLine === undefined || sepLine === undefined) return null;
  if (!headerLine.includes('|')) return null;
  if (!TABLE_SEPARATOR_RE.test(sepLine)) return null;
  const header = splitTableRow(headerLine);
  if (header.length === 0) return null;
  const rows: string[][] = [];
  let i = startLineIdx + 2;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.includes('|') || line.trim() === '') break;
    rows.push(splitTableRow(line));
    i += 1;
  }
  return { header, rows, linesConsumed: i - startLineIdx };
}

/**
 * Tokenize a message body into a small subset of markdown.
 * - `**bold**`, `*italic*`, `` `code` ``, ```` ```code block``` ````, `[label](url)`
 * - GitHub-flavoured tables (`| a | b |` + `|---|---|` separator)
 * - `\` before a trigger renders it literal
 * - Unterminated markers render literal (no wrap-around)
 * - No nesting — outermost marker wins
 */
export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let buf = '';
  let i = 0;
  const flush = (): void => {
    if (buf.length > 0) {
      tokens.push({ kind: 'text', value: buf });
      buf = '';
    }
  };

  // Pre-compute newline positions + current-line index so table detection
  // (which needs whole-line context) can look ahead without re-splitting.
  const lines = input.split('\n');
  const lineStartAtChar = new Array<number>(lines.length);
  {
    let pos = 0;
    for (let li = 0; li < lines.length; li++) {
      lineStartAtChar[li] = pos;
      pos += lines[li]!.length + 1; // +1 for the '\n'
    }
  }
  function lineIndexAt(charIdx: number): number {
    // Linear scan is fine — bodies are short (KB range) and this is only
    // called at newline boundaries.
    for (let li = lines.length - 1; li >= 0; li--) {
      if (lineStartAtChar[li]! <= charIdx) return li;
    }
    return 0;
  }

  while (i < input.length) {
    const ch = input[i]!;

    // Table: only detect at the start of a line (i === 0 or previous char is
    // a newline). Requires a header line, a separator line, and consumes
    // all subsequent body lines that start with `|`.
    if ((i === 0 || input[i - 1] === '\n') && ch === '|') {
      const startLine = lineIndexAt(i);
      const t = tryTable(lines, startLine);
      if (t !== null) {
        flush();
        tokens.push({ kind: 'table', header: t.header, rows: t.rows });
        // Advance past the last consumed line + its trailing newline (if any).
        const lastLineIdx = startLine + t.linesConsumed - 1;
        const afterLast = lineStartAtChar[lastLineIdx]! + lines[lastLineIdx]!.length;
        i = afterLast < input.length && input[afterLast] === '\n' ? afterLast + 1 : afterLast;
        continue;
      }
    }

    if (ch === '\\' && i + 1 < input.length && TRIGGERS.has(input[i + 1]!)) {
      buf += input[i + 1]!;
      i += 2;
      continue;
    }

    // Fenced code block. Accept both the multi-line shape (```\ncode\n```)
    // and the single-line shape (```code```) — the Ink CLI's input can't
    // carry newlines, so users type inline fences.
    if (input.startsWith('```', i)) {
      const close = input.indexOf('```', i + 3);
      if (close > i + 2) {
        // If the first char after ``` is a newline (multi-line form) OR
        // there's a newline before the first close (```lang\ncode\n```),
        // treat that first line as an optional language tag and skip it.
        let contentStart = i + 3;
        const firstNl = input.indexOf('\n', contentStart);
        if (firstNl >= 0 && firstNl < close) contentStart = firstNl + 1;
        // Strip a trailing newline right before the close.
        let contentEnd = close;
        if (input[contentEnd - 1] === '\n') contentEnd -= 1;
        flush();
        tokens.push({ kind: 'code-block', value: input.slice(contentStart, contentEnd) });
        i = close + 3;
        continue;
      }
    }

    if (ch === '*' && input[i + 1] === '*') {
      const close = input.indexOf('**', i + 2);
      if (close > i + 2) {
        flush();
        tokens.push({ kind: 'bold', value: input.slice(i + 2, close) });
        i = close + 2;
        continue;
      }
    }

    if (ch === '*') {
      const close = input.indexOf('*', i + 1);
      if (close > i + 1) {
        flush();
        tokens.push({ kind: 'italic', value: input.slice(i + 1, close) });
        i = close + 1;
        continue;
      }
    }

    if (ch === '`') {
      const close = input.indexOf('`', i + 1);
      if (close > i + 1) {
        flush();
        tokens.push({ kind: 'code', value: input.slice(i + 1, close) });
        i = close + 1;
        continue;
      }
    }

    if (ch === '[') {
      const closeLabel = input.indexOf(']', i + 1);
      if (closeLabel > i + 1 && input[closeLabel + 1] === '(') {
        const closeUrl = input.indexOf(')', closeLabel + 2);
        if (closeUrl > closeLabel + 2) {
          flush();
          tokens.push({ kind: 'link', label: input.slice(i + 1, closeLabel), url: input.slice(closeLabel + 2, closeUrl) });
          i = closeUrl + 1;
          continue;
        }
      }
    }

    buf += ch;
    i += 1;
  }

  flush();
  return tokens;
}

/** Render a table token as monospaced padded rows: header (bold) + a
 *  dim divider line + body rows. Column widths auto-fit to the widest
 *  cell so short cells align, then are compressed proportionally if the
 *  natural total would overflow `maxWidth`. Bounded at 40 chars/col to
 *  keep long free-text cells from stretching the whole pane. */
function renderTable(
  t: { kind: 'table'; header: string[]; rows: string[][] },
  key: number,
  maxWidth: number,
): React.ReactElement {
  const cols = t.header.length;
  const allRows: string[][] = [t.header, ...t.rows.map((r) => {
    const padded = r.slice(0, cols);
    while (padded.length < cols) padded.push('');
    return padded;
  })];
  const widths = new Array<number>(cols).fill(0);
  for (const row of allRows) {
    for (let c = 0; c < cols; c++) {
      const cell = row[c] ?? '';
      widths[c] = Math.min(40, Math.max(widths[c]!, cell.length));
    }
  }
  // Compress if natural width exceeds pane. Separators between cells are
  // ' │ ' (3 chars), so total = sum(widths) + 3*(cols-1). Shrink the widest
  // column by 1 until we fit, flooring each at 1. In tight budgets that
  // makes cells single-char + ellipsis-truncated, which is ugly but
  // preferred over bleeding past the pane border.
  const SEP = 3;
  const separators = SEP * Math.max(0, cols - 1);
  const cellBudget = Math.max(cols, maxWidth - separators);
  let sum = widths.reduce((s, w) => s + w, 0);
  while (sum > cellBudget) {
    let widest = 0;
    for (let c = 1; c < cols; c++) if (widths[c]! > widths[widest]!) widest = c;
    if (widths[widest]! <= 1) break;
    widths[widest] = widths[widest]! - 1;
    sum -= 1;
  }
  function fmtCell(cell: string, w: number): string {
    if (cell.length > w) {
      // At w=1 the ellipsis alone eats the whole cell. Below w=1 we can't
      // render anything meaningful. Above, keep w-1 chars + one ellipsis.
      if (w <= 1) return w === 1 ? '…' : '';
      return cell.slice(0, w - 1) + '…';
    }
    return cell + ' '.repeat(w - cell.length);
  }
  const divider = widths.map((w) => '─'.repeat(w)).join(' ─ ');
  return (
    <Text key={key}>
      {'\n'}
      <Text bold>{t.header.map((h, c) => fmtCell(h, widths[c]!)).join(' │ ')}</Text>{'\n'}
      <Text dimColor>{divider}</Text>{'\n'}
      {t.rows.map((row, rIdx) => (
        <Text key={rIdx}>{row.slice(0, cols).map((cell, c) => fmtCell(cell ?? '', widths[c]!)).join(' │ ')}{'\n'}</Text>
      ))}
    </Text>
  );
}

export function Markdown({ body, baseColor, maxWidth = 80 }: { body: string; baseColor?: string; maxWidth?: number }): React.ReactElement {
  const tokens = tokenize(body);
  return (
    <Text color={baseColor}>
      {tokens.map((t, idx) => {
        switch (t.kind) {
          case 'text':       return <Text key={idx}>{t.value}</Text>;
          case 'bold':       return <Text key={idx} bold>{t.value}</Text>;
          case 'italic':     return <Text key={idx} italic>{t.value}</Text>;
          case 'code':       return <Text key={idx} backgroundColor="gray"> {t.value} </Text>;
          case 'code-block': return <Text key={idx} dimColor>{'\n'}{t.value}{'\n'}</Text>;
          case 'link':       return <Text key={idx} color="cyan" underline>{t.label} <Text dimColor>({t.url})</Text></Text>;
          case 'table':      return renderTable(t, idx, maxWidth);
        }
      })}
    </Text>
  );
}
