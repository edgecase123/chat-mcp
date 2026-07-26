import React from 'react';
import { Box, Text } from 'ink';
import { CATEGORIES, CATEGORY_LABELS, argShape, commandsByCategory } from '../commands.js';
import { KeyboardShortcuts } from './KeyboardShortcuts.js';

export function HelpPane(): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text bold color="cyan">help</Text>
      <Text dimColor>{'─'.repeat(50)}</Text>
      {CATEGORIES.map((cat) => (
        <Box key={cat} flexDirection="column" marginTop={1}>
          <Text bold color="magenta">{CATEGORY_LABELS[cat]}</Text>
          {commandsByCategory(cat).map((c) => (
            <Text key={c.name}>
              {'  '}
              <Text color="cyan" bold>{c.name}</Text>
              {c.args.length > 0 && (
                <>
                  {' '}
                  <Text dimColor>{argShape(c)}</Text>
                </>
              )}
              {'  '}
              <Text dimColor>{c.description}</Text>
            </Text>
          ))}
        </Box>
      ))}
      <Box marginTop={1}>
        <KeyboardShortcuts />
      </Box>
    </Box>
  );
}
