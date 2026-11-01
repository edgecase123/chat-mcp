#!/usr/bin/env node
// Simulate pressing PgUp / PgDn against a headless MessagesPane + verify
// scrollOffset actually changes. If this passes, the bug is in the user's
// terminal (PgUp not delivered) rather than in our scroll logic.

import React from 'react';
import { render } from 'ink-testing-library';
import { MessagesPane } from '../dist/cli/ink/panes/MessagesPane.js';

// Mixed short + very-long messages, matching the real #poker room shape
// (a few multi-thousand-char bodies mixed with short ones).
const messages = Array.from({ length: 16 }, (_, i) => ({
  id: i + 1,
  from_handle: i % 2 === 0 ? 'claude1' : 'me',
  to_handle: i % 2 === 0 ? 'me' : 'claude1',
  body: i === 3 || i === 5 || i === 8 || i === 11
    ? 'x'.repeat(2500)   // heavy multi-line body ≈ 30+ rendered rows
    : `short reply ${i + 1}`,
  sent_at: Date.parse('2026-07-26T14:00:00') + i * 1000,
  kind: 'chat',
  delivered_at: null,
  read_at: null,
}));

const view = { kind: 'dm', peer: 'claude1' };
const { lastFrame, stdin } = render(
  React.createElement(MessagesPane, { view, messages, meHandle: 'me' }),
);

const strip = (s) => (s ?? '').replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
const summary = (label) => {
  const f = strip(lastFrame());
  const olderMatch = f.match(/↑ (\d+) older/);
  const newerMatch = f.match(/↓ (\d+) newer/);
  const topMarker = f.includes('— top of loaded history —');
  process.stdout.write(`[${label}]  older=${olderMatch?.[1] ?? '0'}  newer=${newerMatch?.[1] ?? '0'}  atTop=${topMarker}\n`);
};

// Ink parses PgUp as the escape sequence ESC[5~ and PgDn as ESC[6~.
// stdin.write raw bytes → Ink's key-parser converts to key.pageUp/pageDown.
const PGUP = '\x1b[5~';
const PGDN = '\x1b[6~';
const HOME = '\x1b[H';
const END = '\x1b[F';

async function tick() { await new Promise((r) => setTimeout(r, 50)); }

summary('initial');
stdin.write(PGDN); await tick(); summary('after PgDn');
stdin.write(PGDN); await tick(); summary('after PgDn x2');
stdin.write(PGDN); await tick(); summary('after PgDn x3');
stdin.write(END);  await tick(); summary('after End');
stdin.write(PGUP); await tick(); summary('after PgUp');
stdin.write(HOME); await tick(); summary('after Home');

process.exit(0);
