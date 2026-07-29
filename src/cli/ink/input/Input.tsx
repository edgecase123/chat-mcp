import React from 'react';
import { Text, useInput } from 'ink';

export interface InputProps {
  value: string;
  cursor: number; // 0..value.length
  onChange: (value: string, cursor: number) => void;
  onSubmit: (value: string) => void;
  onTab?: () => void;
  onEsc?: () => void;
  onUp?: () => void;
  onDown?: () => void;
  prompt?: string;
  /**
   * Characters the parent claims as hotkeys when the buffer is empty.
   * When any listed char is typed AND the buffer is empty, Input skips the
   * insert so the parent's global useInput handler owns the keystroke without
   * echoing the char into the input. Necessary because Ink dispatches every
   * key event to every mounted useInput handler.
   */
  emptyBufferHotkeys?: readonly string[];
}

function isWordChar(ch: string): boolean {
  return /[a-zA-Z0-9_]/.test(ch);
}

function prevWordBoundary(s: string, cursor: number): number {
  let i = cursor;
  while (i > 0 && !isWordChar(s[i - 1]!)) i--;
  while (i > 0 && isWordChar(s[i - 1]!)) i--;
  return i;
}

function nextWordBoundary(s: string, cursor: number): number {
  let i = cursor;
  while (i < s.length && !isWordChar(s[i]!)) i++;
  while (i < s.length && isWordChar(s[i]!)) i++;
  return i;
}

export function Input({
  value,
  cursor,
  onChange,
  onSubmit,
  onTab,
  onEsc,
  onUp,
  onDown,
  prompt = '> ',
  emptyBufferHotkeys,
}: InputProps): React.ReactElement {
  useInput((raw, key) => {
    if (key.return) return onSubmit(value);
    if (key.tab) return onTab?.();
    if (key.escape) return onEsc?.();
    if (key.upArrow) return onUp?.();
    if (key.downArrow) return onDown?.();

    if (key.leftArrow) {
      if (key.meta) {
        return onChange(value, prevWordBoundary(value, cursor));
      }
      return onChange(value, Math.max(0, cursor - 1));
    }
    if (key.rightArrow) {
      if (key.meta) {
        return onChange(value, nextWordBoundary(value, cursor));
      }
      return onChange(value, Math.min(value.length, cursor + 1));
    }
    // Readline convention for word-nav: Opt-Left in Terminal.app + iTerm2's
    // default profile sends ESC-b (not ESC-[1;3D), so key.leftArrow is never
    // set — it arrives as `key.meta + raw === 'b'`. Same for Opt-Right → M-f.
    // Handle both aliases so the shortcut works without the user having to
    // change their terminal's Option-key encoding.
    if (key.meta && raw === 'b') return onChange(value, prevWordBoundary(value, cursor));
    if (key.meta && raw === 'f') return onChange(value, nextWordBoundary(value, cursor));

    // Cursor-to-line-start / -line-end. Ctrl-A / Ctrl-E is readline convention,
    // but some terminals (screen, tmux with default-a config, or emulators with
    // Select-All bound to Ctrl-A) intercept Ctrl-A. Home / End is the fallback
    // most terminals deliver even in those setups.
    const k = key as unknown as { home?: boolean; end?: boolean };
    if ((key.ctrl && raw === 'a') || k.home) return onChange(value, 0);
    if ((key.ctrl && raw === 'e') || k.end) return onChange(value, value.length);
    if (key.ctrl && raw === 'u') return onChange(value.slice(cursor), 0);
    if (key.ctrl && raw === 'w') {
      const start = prevWordBoundary(value, cursor);
      return onChange(value.slice(0, start) + value.slice(cursor), start);
    }
    if (key.meta && raw === 'd') {
      const end = nextWordBoundary(value, cursor);
      return onChange(value.slice(0, cursor) + value.slice(end), cursor);
    }

    if (key.backspace || key.delete) {
      // Notes: on macOS the Delete key sends key.backspace; fn-Delete (forward)
      // sends key.delete. Opt-Backspace sends key.meta + key.backspace.
      if (key.meta && key.backspace) {
        const start = prevWordBoundary(value, cursor);
        return onChange(value.slice(0, start) + value.slice(cursor), start);
      }
      if (key.backspace) {
        if (cursor === 0) return;
        return onChange(value.slice(0, cursor - 1) + value.slice(cursor), cursor - 1);
      }
      if (key.delete) {
        if (cursor === value.length) return;
        return onChange(value.slice(0, cursor) + value.slice(cursor + 1), cursor);
      }
    }

    // Printable insert. Ink hands us `raw` as the pasted/typed string.
    if (raw && !key.ctrl && !key.meta) {
      // If buffer is empty and this char is claimed by the parent (e.g. sidebar
      // jump digits or ? / R hotkeys), skip the insert so it doesn't echo.
      if (value.length === 0 && emptyBufferHotkeys && emptyBufferHotkeys.includes(raw)) return;
      const next = value.slice(0, cursor) + raw + value.slice(cursor);
      return onChange(next, cursor + raw.length);
    }
  });

  const before = value.slice(0, cursor);
  const atChar = value[cursor];
  const after = atChar === undefined ? '' : value.slice(cursor + 1);
  // Emit as ONE ANSI-styled string, not nested <Text>. Ink's wrap works on
  // the string content, and nested <Text> children in a Text parent were
  // being measured as opaque segments — when `before` overflowed and Ink
  // wrapped it, the cursor `<Text>` stuck to the tail of the first visual
  // line rather than the tail of the logical string. Embedded ANSI escapes
  // are transparent to the wrap algorithm.
  const CYAN = '\x1b[36m';
  const RESET = '\x1b[39m';
  const INV = '\x1b[7m';
  const NOINV = '\x1b[27m';
  const cursorAnsi = atChar === undefined
    // Past end of buffer — render a solid block; some terminals collapse
    // inverse-space to empty space, hiding the cursor.
    ? `${CYAN}█${RESET}`
    // On a real char — inverse the char in place.
    : `${INV}${atChar}${NOINV}`;
  const line = `${CYAN}${prompt}${RESET}${before}${cursorAnsi}${after}`;
  return <Text>{line}</Text>;
}
