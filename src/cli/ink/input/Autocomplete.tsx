import React from 'react';
import { Box, Text } from 'ink';
import type { Completion } from './completions.js';

export interface AutocompleteProps {
  completions: Completion[];
  selectedIndex: number;
  maxRows?: number;
}

export function Autocomplete({ completions, selectedIndex, maxRows = 6 }: AutocompleteProps): React.ReactElement | null {
  if (completions.length === 0) return null;
  const visible = completions.slice(0, maxRows);
  return (
    <Box borderStyle="round" borderColor="cyan" flexDirection="column" paddingX={1}>
      {visible.map((c, i) => {
        const active = i === selectedIndex;
        return (
          <Text key={c.value + i}>
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
      {completions.length > maxRows && (
        <Text dimColor>… {completions.length - maxRows} more</Text>
      )}
    </Box>
  );
}
