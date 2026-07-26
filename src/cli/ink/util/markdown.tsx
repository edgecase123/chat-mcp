import React from 'react';
import { Text } from 'ink';

export type Token =
  | { kind: 'text'; value: string }
  | { kind: 'bold'; value: string }
  | { kind: 'italic'; value: string }
  | { kind: 'code'; value: string }
  | { kind: 'code-block'; value: string }
  | { kind: 'link'; label: string; url: string };

const TRIGGERS = new Set(['*', '`', '[', '\\']);

/**
 * Tokenize a message body into a small subset of markdown.
 * - `**bold**`, `*italic*`, `` `code` ``, ```` ```code block``` ````, `[label](url)`
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

  while (i < input.length) {
    const ch = input[i]!;

    if (ch === '\\' && i + 1 < input.length && TRIGGERS.has(input[i + 1]!)) {
      buf += input[i + 1]!;
      i += 2;
      continue;
    }

    // Fenced code block
    if (input.startsWith('```', i)) {
      const nlAfterOpen = input.indexOf('\n', i + 3);
      const close = input.indexOf('\n```', nlAfterOpen >= 0 ? nlAfterOpen : i + 3);
      if (nlAfterOpen >= 0 && close >= 0) {
        flush();
        tokens.push({ kind: 'code-block', value: input.slice(nlAfterOpen + 1, close) });
        i = close + 4;
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

export function Markdown({ body, baseColor }: { body: string; baseColor?: string }): React.ReactElement {
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
        }
      })}
    </Text>
  );
}
