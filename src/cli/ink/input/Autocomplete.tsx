import React from 'react';
import { Box, Text } from 'ink';
import type { Completion } from './completions.js';

export interface AutocompleteProps {
  completions: Completion[];
  selectedIndex: number;
  maxRows?: number;
}

/**
 * Sliding-window dropdown: keeps the selected row inside the visible slice
 * as the user arrows up/down through more items than fit. Also surfaces
 * "N more above/below" indicators at the window edges.
 */
export function Autocomplete({ completions, selectedIndex, maxRows = 6 }: AutocompleteProps): React.ReactElement | null {
  if (completions.length === 0) return null;

  // Window start: keep selected in view. If selectedIndex is within [0, maxRows)
  // we start at 0; otherwise shift so selectedIndex sits at the bottom of the
  // window (giving the user maximum context of items above).
  const windowStart = Math.max(
    0,
    Math.min(completions.length - maxRows, selectedIndex - maxRows + 1),
  );
  const windowEnd = Math.min(completions.length, windowStart + maxRows);
  const visible = completions.slice(windowStart, windowEnd);
  const above = windowStart;
  const below = completions.length - windowEnd;

  return (
    <Box borderStyle="round" borderColor="cyan" flexDirection="column" paddingX={1} flexShrink={0}>
      {above > 0 && <Text dimColor>↑ {above} more</Text>}
      {visible.map((c, i) => {
        const absoluteIndex = windowStart + i;
        const active = absoluteIndex === selectedIndex;
        return (
          <Text key={c.value + absoluteIndex}>
            {active ? <Text color="cyan">▸ </Text> : <Text>  </Text>}
            <Text bold={active} color={active ? 'cyan' : undefined}>{c.display ?? c.value}</Text>
            {c.description && (
              <>
                {'  '}
                <Text dimColor>— {c.description}</Text>
              </>
            )}
          </Text>
        );
      })}
      {below > 0 && <Text dimColor>↓ {below} more</Text>}
    </Box>
  );
}
