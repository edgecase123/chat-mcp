#!/usr/bin/env node
// Wide-terminal reproduction — user runs at ~220 cols and reports layout
// corruption. Use ink's real render with a custom writable that captures
// the frame bytes so we can inspect what Ink writes at wide widths.

import React from 'react';
import { EventEmitter } from 'node:events';
import { render } from 'ink';

const COLS = parseInt(process.env.COLS ?? '220', 10);
const ROWS = parseInt(process.env.ROWS ?? '30', 10);

class MockStdout extends EventEmitter {
  columns = COLS;
  rows = ROWS;
  isTTY = true;
  frames = [];
  write(frame) { this.frames.push(String(frame)); }
  lastFrame() { return this.frames[this.frames.length - 1]; }
}

class MockStdin extends EventEmitter {
  isTTY = true;
  setRawMode() {}
  setEncoding() {}
  resume() {}
  pause() {}
  ref() {}
  unref() {}
  read() { return null; }
}

const stdout = new MockStdout();
const stdin = new MockStdin();

const { Box, Text } = await import('ink');
const { Header } = await import('../dist/cli/ink/panes/Header.js');
const { Sidebar } = await import('../dist/cli/ink/panes/Sidebar.js');
const { MessagesPane } = await import('../dist/cli/ink/panes/MessagesPane.js');
const { HintBar } = await import('../dist/cli/ink/HintBar.js');

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
  { flexDirection: 'column', width: '100%', height: ROWS, overflow: 'hidden' },
  React.createElement(Header, { handle: 'me', version: '0.3.0', status: null, focus: null }),
  React.createElement(
    Box,
    { flexGrow: 1, overflow: 'hidden' },
    React.createElement(Sidebar, {
      handle: 'me', view, peers, memberRooms, discoverRooms,
      dmUnreadByPeer: new Map(), roomUnreadByName: new Map(),
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

const instance = render(layout, {
  stdout,
  stdin,
  debug: true,
  exitOnCtrlC: false,
});

await new Promise((r) => setTimeout(r, 300));
process.stderr.write(`captured ${stdout.frames.length} frames\n`);
instance.unmount();

// Use the last non-empty frame.
const raw = [...stdout.frames].reverse().find((f) => f.trim().length > 10) ?? '';
const stripped = raw.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
stripped.split('\n').forEach((line, i) => {
  process.stdout.write(String(i + 1).padStart(3) + '│' + line + '\n');
});
process.exit(0);
