import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { Message } from '../../../storage/dao.js';

export interface ScrollableMessageListProps {
  messages: Message[];
  meHandle: string;
  viewportRows: number;
  /** When true, this list receives PgUp/PgDn/Home/End */
  focused?: boolean;
  /** Optional shift modifier — true means "only fire on Shift-Pg*" (used for the watch pane so it doesn't collide with the primary list) */
  requireShift?: boolean;
  renderRow: (m: Message, meHandle: string) => React.ReactElement;
}

/**
 * Message list with keyboard scrolling + auto-follow at bottom.
 * scrollOffset === 0 means pinned to newest; N means scrolled back N rows.
 * When pinned, incoming messages stay pinned. When scrolled back, incoming
 * messages don't shift the view — a `↓ N newer` indicator surfaces the delta.
 */
export function ScrollableMessageList({
  messages,
  meHandle,
  viewportRows,
  focused = true,
  requireShift = false,
  renderRow,
}: ScrollableMessageListProps): React.ReactElement {
  const [scrollOffset, setScrollOffset] = useState(0);
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

  useInput((_raw, key) => {
    if (!focused) return;
    if (requireShift && !key.shift) return;
    const step = Math.max(1, viewportRows - 2);
    if (key.pageUp) return setScrollOffset((o) => Math.min(Math.max(0, messages.length - viewportRows), o + step));
    if (key.pageDown) return setScrollOffset((o) => Math.max(0, o - step));
    // Ink 5.x has key.home / key.end on some builds; guard via feature-detect.
    const k = key as unknown as { home?: boolean; end?: boolean };
    if (k.home) return setScrollOffset(Math.max(0, messages.length - viewportRows));
    if (k.end) return setScrollOffset(0);
  });

  const end = messages.length - scrollOffset;
  const start = Math.max(0, end - viewportRows);
  const visible = messages.slice(start, end);
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
