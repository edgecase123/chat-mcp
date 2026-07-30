import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { Message } from '../../../storage/dao.js';

export interface ScrollableMessageListProps {
  messages: Message[];
  meHandle: string;
  /** Row budget for the visible slice — walked backward from the anchor. */
  viewportRows: number;
  /** Approximate content width for the fallback char-count row estimate.
   *  When `rowsForMessage` is provided, this is unused for row estimation
   *  and only carried for backward compatibility. */
  contentColumns: number;
  /** When true, this list receives PgUp/PgDn/Home/End/Ctrl-P/Ctrl-N. */
  focused?: boolean;
  /** Optional shift modifier — true means "only fire on Shift-Pg*". Kept
   *  for backward-compat; new callers manage per-pane focus via `focused`. */
  requireShift?: boolean;
  /** Caller-supplied row estimator. Prefer this — the internal char-count
   *  fallback under-counts because real wrap only breaks at whitespace, so
   *  a long message renders taller than `ceil(length / cols)` suggests. */
  rowsForMessage?: (m: Message) => number;
  renderRow: (m: Message, meHandle: string) => React.ReactElement;
}

/**
 * Fallback row estimator when `rowsForMessage` isn't supplied. Cheap
 * approximation; MessagesPane + the watch pane bypass this by passing
 * their exact wrap-width-aware estimator.
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
 * ROW budget: we walk backward from the anchor, estimating rendered rows
 * per message, and stop when adding another would overflow the budget.
 * The anchor message is always fully visible — we don't try to clip
 * partial messages because Ink's overflow-hidden mis-renders nested Box
 * children (single-Text with \n clips fine; nested Box children scramble).
 *
 * Scroll units:
 * - Ctrl-P / Ctrl-N — one message back / forward (fine control)
 * - PgUp / PgDn — one page (viewport-worth of messages, whatever fits)
 * - Home — oldest loaded message
 * - End — pinned to newest (auto-follow re-arms)
 */
export function ScrollableMessageList({
  messages,
  meHandle,
  viewportRows,
  contentColumns,
  focused = true,
  requireShift = false,
  rowsForMessage,
  renderRow,
}: ScrollableMessageListProps): React.ReactElement {
  // On mount (and on remount via `key` from the parent when the chat target
  // changes), anchor at the OLDEST message so the user reads forward
  // instead of hunting backward.
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

  // Compute the visible slice by walking BACKWARD from the anchor.
  const end = messages.length - scrollOffset;
  let start = end;
  let usedRows = 0;
  while (start > 0) {
    const m = messages[start - 1]!;
    const rows = rowsForMessage ? rowsForMessage(m) : estimateMessageRows(m.body, contentColumns);
    if (usedRows + rows > viewportRows && start !== end) break;
    usedRows += rows;
    start -= 1;
  }
  const visible = messages.slice(start, end);

  // Page step: how many messages fit in the current viewport.
  const pageStep = Math.max(1, visible.length);
  const maxOffset = Math.max(0, messages.length - 1);

  useInput((raw, key) => {
    if (!focused) return;
    if (requireShift && !key.shift) return;
    // Ctrl-P / Ctrl-N — one message back / forward.
    if (key.ctrl && raw === 'p') return setScrollOffset((o) => Math.min(maxOffset, o + 1));
    if (key.ctrl && raw === 'n') return setScrollOffset((o) => Math.max(0, o - 1));
    // PgUp / PgDn — one page (whatever fits in the viewport).
    if (key.pageUp) return setScrollOffset((o) => Math.min(maxOffset, o + pageStep));
    if (key.pageDown) return setScrollOffset((o) => Math.max(0, o - pageStep));
    if (key.home) return setScrollOffset(maxOffset);
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
