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

export function HintBar({ view, watchOpen = false, focusedPane = 'main' }: { view: View; watchOpen?: boolean; focusedPane?: 'main' | 'watch' }): React.ReactElement {
  const base = HINTS[view.kind];
  const watchHint = watchOpen
    ? ` · Ctrl-O focus ${focusedPane === 'main' ? 'watch' : 'main'} · /unwatch`
    : '';
  return (
    <Box paddingX={1} flexShrink={0}>
      <Text dimColor>{base}{watchHint}</Text>
    </Box>
  );
}
