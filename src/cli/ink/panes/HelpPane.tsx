import React from 'react';
import { Box, Text } from 'ink';
import { CATEGORIES, CATEGORY_LABELS, argShape, commandsByCategory } from '../commands.js';

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
      <Box marginTop={1} flexDirection="column">
        <Text bold color="magenta">KEYBOARD</Text>
        <Text>  <Text color="cyan" bold>Ctrl-K</Text>   command palette</Text>
        <Text>  <Text color="cyan" bold>Tab</Text>      complete peer/room in current arg</Text>
        <Text>  <Text color="cyan" bold>↑↓</Text>       navigate autocomplete / palette</Text>
        <Text>  <Text color="cyan" bold>1-9</Text>      jump to sidebar entry (when input empty)</Text>
        <Text>  <Text color="cyan" bold>R</Text>        open /rooms browser (when input empty)</Text>
        <Text>  <Text color="cyan" bold>?</Text>        open this help (when input empty)</Text>
        <Text>  <Text color="cyan" bold>Ctrl-A/E</Text>  cursor start/end of line</Text>
        <Text>  <Text color="cyan" bold>Ctrl-W</Text>    delete previous word</Text>
        <Text>  <Text color="cyan" bold>Ctrl-U</Text>    delete to start of line</Text>
        <Text>  <Text color="cyan" bold>Opt-←/→</Text>   word navigation (Mac)</Text>
        <Text>  <Text color="cyan" bold>Opt-⌫</Text>     delete previous word (Mac)</Text>
        <Text>  <Text color="cyan" bold>↑↓</Text>        input history (when no dropdown)</Text>
        <Text>  <Text color="cyan" bold>Ctrl-C</Text>    quit</Text>
        <Text dimColor>  (Cmd-* combos are intercepted by the terminal and unavailable.)</Text>
      </Box>
    </Box>
  );
}
