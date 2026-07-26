import React, { useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { COMMANDS, argShape } from '../commands.js';
import type { Command } from '../commands.js';
import { fuzzyFilter } from '../fuzzy.js';

export interface PaletteProps {
  onSelect: (cmd: Command) => void;
  onClose: () => void;
}

export function Palette({ onSelect, onClose }: PaletteProps): React.ReactElement {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const matches = useMemo(
    () => fuzzyFilter(query, COMMANDS, (c) => `${c.name} ${c.description}`),
    [query],
  );

  useInput((raw, key) => {
    if (key.escape) return onClose();
    if (key.return) {
      const pick = matches[selected];
      if (pick) onSelect(pick);
      return;
    }
    if (key.upArrow) return setSelected((i) => Math.max(0, i - 1));
    if (key.downArrow) return setSelected((i) => Math.min(matches.length - 1, i + 1));
    if (key.backspace) {
      setQuery((q) => q.slice(0, -1));
      setSelected(0);
      return;
    }
    if (raw && !key.ctrl && !key.meta) {
      setQuery((q) => q + raw);
      setSelected(0);
    }
  });

  const visible = matches.slice(0, 8);

  return (
    <Box borderStyle="round" borderColor="magenta" flexDirection="column" paddingX={1}>
      <Text color="magenta" bold>⌘K COMMANDS</Text>
      <Box>
        <Text>🔍 </Text>
        <Text>{query}</Text>
        <Text inverse> </Text>
      </Box>
      {visible.length === 0 ? (
        <Text dimColor>(no matches)</Text>
      ) : (
        visible.map((c, i) => {
          const active = i === selected;
          return (
            <Text key={c.name}>
              {active ? <Text color="magenta">▸ </Text> : <Text>  </Text>}
              <Text bold={active} color={active ? 'magenta' : 'cyan'}>{c.name}</Text>
              {c.args.length > 0 && (
                <>
                  {' '}
                  <Text dimColor>{argShape(c)}</Text>
                </>
              )}
              {'  '}
              <Text dimColor>— {c.description}</Text>
            </Text>
          );
        })
      )}
      <Text dimColor>↑↓ move · Enter run · Esc close</Text>
    </Box>
  );
}
