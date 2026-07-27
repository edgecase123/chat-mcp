import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { Message } from '../../../storage/dao.js';
import { stampOf as timeOf } from '../../../util/time.js';

/**
 * Chrome-free view of the current message list, intended for mouse-selection
 * + copy. No borders (nothing for a drag to accidentally scoop up), no colors
 * that don't survive a paste, no sidebar or input to steal columns.
 *
 * PgUp / PgDn / Home / End still scroll so the user can bring an older
 * message into view before selecting. Esc returns to normal mode.
 */
export interface CopyPaneProps {
  messages: Message[];
  viewportRows: number;
  onExit: () => void;
}

export function CopyPane({ messages, viewportRows, onExit }: CopyPaneProps): React.ReactElement {
  const [scrollOffset, setScrollOffset] = useState(0);

  useInput((_raw, key) => {
    if (key.escape) return onExit();
    const step = Math.max(1, viewportRows - 2);
    if (key.pageUp) return setScrollOffset((o) => Math.min(Math.max(0, messages.length - viewportRows), o + step));
    if (key.pageDown) return setScrollOffset((o) => Math.max(0, o - step));
    const k = key as unknown as { home?: boolean; end?: boolean };
    if (k.home) return setScrollOffset(Math.max(0, messages.length - viewportRows));
    if (k.end) return setScrollOffset(0);
  });

  const end = messages.length - scrollOffset;
  const start = Math.max(0, end - viewportRows);
  const visible = messages.slice(start, end);
  const olderHidden = start;
  const newerHidden = scrollOffset;

  return (
    <Box flexDirection="column">
      {olderHidden > 0 && <Text dimColor>↑ {olderHidden} older</Text>}
      {visible.length === 0 ? (
        <Text dimColor>(no messages)</Text>
      ) : (
        visible.map((m) => (
          <Box key={m.id} flexDirection="column">
            <Text>{m.from_handle}  {timeOf(m.sent_at)}</Text>
            <Text>  {m.body}</Text>
          </Box>
        ))
      )}
      {newerHidden > 0 && <Text dimColor>↓ {newerHidden} newer</Text>}
      <Text dimColor>— copy mode · Esc to exit · PgUp/PgDn to scroll —</Text>
    </Box>
  );
}
