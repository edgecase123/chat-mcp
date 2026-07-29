import React from 'react';
import { Box, Text } from 'ink';

/**
 * Keyboard-shortcut reference. Rendered inside HelpPane as one section
 * and standalone by KeyboardPane (opened via /keyboard or the ? hotkey
 * if the user only wants the shortcut sheet).
 */
export function KeyboardShortcuts(): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text bold color="magenta">KEYBOARD</Text>
      <Text>  <Text color="cyan" bold>Ctrl-K</Text>   command palette</Text>
      <Text>  <Text color="cyan" bold>Tab</Text>      complete peer/room in current arg</Text>
      <Text>  <Text color="cyan" bold>↑↓</Text>       navigate autocomplete / palette</Text>
      <Text>  <Text color="cyan" bold>1-9</Text>      jump to sidebar entry (when input empty)</Text>
      <Text>  <Text color="cyan" bold>Ctrl-R</Text>   open /rooms browser</Text>
      <Text>  <Text color="cyan" bold>?</Text>        open /help (when input empty)</Text>
      <Text>  <Text color="cyan" bold>Home/End</Text>  cursor start/end of line (preferred)</Text>
      <Text>  <Text color="cyan" bold>Ctrl-A/E</Text>  same (some terminals swallow — e.g. screen)</Text>
      <Text>  <Text color="cyan" bold>Ctrl-W</Text>    delete previous word</Text>
      <Text>  <Text color="cyan" bold>Ctrl-U</Text>    delete to start of line</Text>
      <Text>  <Text color="cyan" bold>Opt-←/→</Text>   word navigation (Mac)</Text>
      <Text>  <Text color="cyan" bold>Opt-⌫</Text>     delete previous word (Mac)</Text>
      <Text>  <Text color="cyan" bold>Opt-D</Text>     delete next word (Mac)</Text>
      <Text>  <Text color="cyan" bold>↑↓</Text>        input history (when no dropdown)</Text>
      <Text>  <Text color="cyan" bold>PgUp/Dn</Text>   scroll focused pane (or <Text color="cyan" bold>Ctrl-P/N</Text> if no PgUp key)</Text>
      <Text>  <Text color="cyan" bold>Ctrl-O</Text>    toggle scroll focus between main and watch pane</Text>
      <Text>  <Text color="cyan" bold>/copy</Text>    chrome-free view for mouse-copy (Esc to exit)</Text>
      <Text>  <Text color="cyan" bold>Ctrl-C</Text>    quit</Text>
      <Text dimColor>  (Cmd-* combos are intercepted by the terminal and unavailable.)</Text>
    </Box>
  );
}
