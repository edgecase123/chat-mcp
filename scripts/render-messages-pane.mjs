#!/usr/bin/env node
// Headless render of MessagesPane in a fixed viewport, so I can see exactly
// what the layout emits — no alt-screen dance required.

import React from 'react';
import { render } from 'ink-testing-library';
import { MessagesPane } from '../dist/cli/ink/panes/MessagesPane.js';

const messages = [
  { id: 1, from_handle: 'lee', to_handle: 'me', body: 'complete. Lee — please run the browser-console fetch and hit /poker; post results.', sent_at: Date.parse('2026-07-26T14:38:49'), kind: 'chat', delivered_at: null, read_at: null },
  { id: 2, from_handle: 'claude1', to_handle: 'me', body: 'give me the fetch command again', sent_at: Date.parse('2026-07-26T14:39:05'), kind: 'chat', delivered_at: null, read_at: null },
  { id: 3, from_handle: 'claude1', to_handle: 'me', body: "fetch('/api/v1/me', {credentials: 'include'}).then(r => r.json())", sent_at: Date.parse('2026-07-26T14:39:07'), kind: 'chat', delivered_at: null, read_at: null },
  { id: 4, from_handle: 'pclaude', to_handle: 'me', body: 'Run from devtools console on any authenticated leagues page. Expect 200 {data: {...}}.', sent_at: Date.parse('2026-07-26T14:39:09'), kind: 'chat', delivered_at: null, read_at: null },
  { id: 5, from_handle: 'claude1', to_handle: 'me', body: 'old1\nExiting. Task #1 marked complete on my side.', sent_at: Date.parse('2026-07-26T14:41:07'), kind: 'chat', delivered_at: null, read_at: null },
];

const view = { kind: 'dm', peer: 'claude1' };

const { lastFrame } = render(
  React.createElement(MessagesPane, { view, messages, meHandle: 'me' }),
  { stdout: Object.assign(process.stdout, { columns: 120, rows: 30 }) },
);

// Print with row numbers so I can see wrapping / column drift.
const out = lastFrame() ?? '';
out.split('\n').forEach((line, i) => {
  process.stdout.write(String(i + 1).padStart(3) + '│' + line + '\n');
});
