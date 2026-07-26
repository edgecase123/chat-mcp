import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { Message } from '../../../storage/dao.js';

export interface ScrollableMessageListProps {
  messages: Message[];
  meHandle: string;
  /** Row budget for the visible slice — walked backward from the anchor. */
  viewportRows: number;
  /** Approximate content width for wrap-row estimation (terminal columns
   *  minus sidebar + borders + padding). Used only to estimate how many
   *  rows a message body will wrap to. */
  contentColumns: number;
  /** When true, this list receives PgUp/PgDn/Home/End */
  focused?: boolean;
  /** Optional shift modifier — true means "only fire on Shift-Pg*" (used
   *  for the watch pane so it doesn't collide with the primary list) */
  requireShift?: boolean;
  renderRow: (m: Message, meHandle: string) => React.ReactElement;
}

/**
 * Estimate the terminal rows one rendered message will occupy at a given
 * content width. Header line (sender + timestamp) is 1 row; body wraps
 * per its \n splits and character length. Cheap approximation — good
 * enough to slice a viewport without measuring the actual layout.
 */
function estimateMessageRows(body: string, cols: number): number {
  const width = Math.max(20, cols);
  const lines = body.length === 0 ? [''] : body.split('\n');
  const bodyRows = lines.reduce(
    (sum, line) => sum + Math.max(1, Math.ceil(line.length / width)),
    0,
  );
  return 1 /* header */ + bodyRows;
}

/**
 * Message list with row-budget-aware scrolling + auto-follow at bottom.
 *
 * `scrollOffset` counts messages back from the newest. `viewportRows` is a
 * ROW budget: we walk the messages array backward from the anchor,
 * estimating rendered rows per message, and stop when adding another
 * would exceed the budget. That prevents a small handful of long
 * (multi-line body) messages from saturating the pane while leaving
 * shorter messages inaccessible via PgUp.
 *
 * scrollOffset === 0 means pinned to newest; auto-follow re-arms when
 * the user reaches it. When scrolled back, incoming messages don't
 * shift the view — the `↓ N newer` indicator surfaces the delta.
 */
export function ScrollableMessageList({
  messages,
  meHandle,
  viewportRows,
  contentColumns,
  focused = true,
  requireShift = false,
  renderRow,
}: ScrollableMessageListProps): React.ReactElement {
  // On mount (and on remount via `key` from the parent when the chat target
  // changes), anchor at the OLDEST message so the user reads forward
  // instead of hunting backward. `messages.length - 1` covers every message;
  // clamped below to 0 in the auto-follow re-arm.
  const [scrollOffset, setScrollOffset] = useState<number>(() =>
    Math.max(0, messages.length - 1),
  );
  const prevLenRef = useRef(messages.length);

  // When new messages arrive AND we're scrolled back, grow the offset by
  // the delta so the user's read position doesn't shift under them.
  useEffect(() => {
    const delta = messages.length - prevLenRef.current;
    prevLenRef.current = messages.length;
    if (delta > 0 && scrollOffset > 0) {
      setScrollOffset((o) => o + delta);
    }
  }, [messages.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Compute the visible slice by walking BACKWARD from the anchor
  // and adding messages until we exceed the row budget. Guarantees the
  // anchor message is fully visible at the bottom of the pane.
  const end = messages.length - scrollOffset;
  let start = end;
  let usedRows = 0;
  while (start > 0) {
    const m = messages[start - 1]!;
    const rows = estimateMessageRows(m.body, contentColumns);
    if (usedRows + rows > viewportRows && start !== end) break;
    usedRows += rows;
    start -= 1;
  }
  const visible = messages.slice(start, end);

  // Scroll step: one page. We can't compute this precisely without also
  // estimating "how many messages sit above the current window", so
  // approximate one page as the number of messages currently visible.
  // Never step below 1 (single-message advance if only 1 fits).
  const step = Math.max(1, visible.length);

  useInput((raw, key) => {
    if (!focused) return;
    if (requireShift && !key.shift) return;
    // PgUp / PgDn / Home / End when the terminal delivers them.
    // Macbook users without a dedicated PgUp/PgDn/Home/End key need Fn-arrow,
    // which is easy to forget — so Ctrl-P (previous / older) and Ctrl-N
    // (next / newer) also scroll.
    if (key.pageUp || (key.ctrl && raw === 'p')) {
      return setScrollOffset((o) => Math.min(Math.max(0, messages.length - 1), o + step));
    }
    if (key.pageDown || (key.ctrl && raw === 'n')) {
      return setScrollOffset((o) => Math.max(0, o - step));
    }
    if (key.home) return setScrollOffset(Math.max(0, messages.length - 1));
    if (key.end) return setScrollOffset(0);
  });

  const newerHidden = scrollOffset;
  const olderHidden = start;
  const atTop = start === 0;
  const scrolled = scrollOffset > 0;

  return (
    <Box flexDirection="column" flexGrow={1}>
      {atTop && scrolled && (
        <Text dimColor>— top of loaded history —</Text>
      )}
      {olderHidden > 0 && (
        <Text dimColor>↑ {olderHidden} older</Text>
      )}
      {visible.map((m) => renderRow(m, meHandle))}
      {newerHidden > 0 && (
        <Text dimColor>↓ {newerHidden} newer</Text>
      )}
    </Box>
  );
}
