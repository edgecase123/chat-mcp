#!/usr/bin/env node
// Reproduce the DM layout the user screenshot showed breaking.
// Same composition as App.tsx but hardcoded to a DM view with realistic messages.

import React from 'react';
import { render } from 'ink-testing-library';

process.stdout.columns = parseInt(process.env.COLS ?? '140', 10);
process.stdout.rows = parseInt(process.env.ROWS ?? '30', 10);

const { Box, Text } = await import('ink');
const { Header } = await import('../dist/cli/ink/panes/Header.js');
const { Sidebar } = await import('../dist/cli/ink/panes/Sidebar.js');
const { MessagesPane } = await import('../dist/cli/ink/panes/MessagesPane.js');
const { HintBar } = await import('../dist/cli/ink/HintBar.js');

// Small set so the whole thing fits within viewport (viewport ≈ 5 messages).
const messages = [
  { id: 5, from_handle: 'lee', to_handle: 'me', body: '"name," "tadmin@worldlocaltour.com", "vatars/tckDW4hxm5nmXKFyxZzjVa6OjWotr1titSl5UcAz.jpg"', sent_at: Date.parse('2026-07-26T14:40:05'), kind: 'chat', delivered_at: null, read_at: null },
  { id: 6, from_handle: 'lee', to_handle: 'me', body: 'Confirmed — fix works. /api/v1/me returns 200 + {data: {id, email, name, avatar_url}}. RCA validated.', sent_at: Date.parse('2026-07-26T14:40:07'), kind: 'chat', delivered_at: null, read_at: null },
];

const view = { kind: 'dm', peer: 'claude1' };
const peers = [
  { handle: 'lee', display_name: 'lee', online: true, status: null, focus: null, kind: 'human', pid: null, session_id: '', registered_at: 0, last_seen_at: 0, metadata: {}, status_updated_at: null },
  { handle: 'claude1', display_name: 'claude1', online: true, status: null, focus: null, kind: 'agent', pid: null, session_id: '', registered_at: 0, last_seen_at: 0, metadata: {}, status_updated_at: null },
];
const memberRooms = [];
const discoverRooms = [{ name: '#leagues', created_at: 0, created_by: 'lee', member_count: 2 }];

const layout = React.createElement(
  Box,
  { flexDirection: 'column', width: '100%', height: 30, overflow: 'hidden' },
  React.createElement(Header, { handle: 'me', version: '0.3.0', status: null, focus: null }),
  React.createElement(
    Box,
    { flexGrow: 1, overflow: 'hidden' },
    React.createElement(Sidebar, {
      handle: 'me',
      view,
      peers,
      memberRooms,
      discoverRooms,
      dmUnreadByPeer: new Map(),
      roomUnreadByName: new Map(),
    }),
    React.createElement(
      Box,
      { flexDirection: 'column', flexGrow: 1, borderStyle: 'round', borderColor: 'gray', paddingX: 1 },
      React.createElement(MessagesPane, { view, messages, meHandle: 'me' }),
    ),
  ),
  React.createElement(HintBar, { view }),
  React.createElement(
    Box,
    { borderStyle: 'round', borderColor: 'gray', paddingX: 1, flexShrink: 0 },
    React.createElement(Text, { color: 'cyan' }, '> '),
  ),
);

const { lastFrame } = render(layout);
await new Promise((r) => setTimeout(r, 100));

const out = lastFrame() ?? '(no frame)';
out.split('\n').forEach((line, i) => {
  process.stdout.write(String(i + 1).padStart(3) + '│' + line + '\n');
});
process.exit(0);
