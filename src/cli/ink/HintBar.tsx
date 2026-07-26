import React from 'react';
import { Box, Text } from 'ink';
import type { View } from './views.js';

const HINTS: Record<View['kind'], string> = {
  home:     'Ctrl-K commands · ↑↓ history · /join #room · /dm peer · 1-9 jump · ? help',
  dm:       '↑↓ history · Tab complete · Ctrl-K commands · /watch peer · /back home · ? help',
  room:     '↑↓ history · Tab complete · Ctrl-K commands · /leave · /back home · ? help',
  rooms:    '↑↓ move · Enter open/join · /back home',
  who:      '/back close · ? help',
  help:     '/back close · /keyboard shortcuts-only',
  keyboard: '/back close · /help full help',
};

export function HintBar({ view }: { view: View }): React.ReactElement {
  return (
    <Box paddingX={1}>
      <Text dimColor>{HINTS[view.kind]}</Text>
    </Box>
  );
}
