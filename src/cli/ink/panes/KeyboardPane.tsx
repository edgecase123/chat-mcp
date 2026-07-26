import React from 'react';
import { Box, Text } from 'ink';
import { KeyboardShortcuts } from './KeyboardShortcuts.js';

export function KeyboardPane(): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text bold color="cyan">keyboard shortcuts</Text>
      <Text dimColor>{'─'.repeat(50)}</Text>
      <Box marginTop={1}>
        <KeyboardShortcuts />
      </Box>
    </Box>
  );
}
