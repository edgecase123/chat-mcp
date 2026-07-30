#!/usr/bin/env node
/**
 * Smoke test: render real #poker room messages via ink-testing-library
 * at realistic terminal widths, then look for lines that overflow the
 * pane content width. Prints a report of any overflow with the offending
 * body + surrounding context.
 *
 * Usage: node scripts/probe-poker.mjs [ordinalStart] [ordinalCount] [termCols] [watchOpen]
 * Defaults: 190 20 180 true   (walks from ordinal 190, 20 messages, 180-col term, watch open)
 */
import { DatabaseSync } from 'node:sqlite';
import React from 'react';
import { render } from 'ink-testing-library';
import { Box } from 'ink';
import { MessagesPane } from '../dist/cli/ink/panes/MessagesPane.js';

const DB_PATH = process.env.CHAT_MCP_DB ?? `${process.env.HOME}/.chat-mcp/chat.db`;
const ordinalStart = Number(process.argv[2] ?? 190);
const ordinalCount = Number(process.argv[3] ?? 20);
const termCols     = Number(process.argv[4] ?? 180);
const watchOpen    = (process.argv[5] ?? 'true') === 'true';

// Mirror App.tsx's chrome arithmetic exactly.
const contentColumns = Math.max(20, termCols - 36 - 4 - (watchOpen ? 34 : 0));

const db = new DatabaseSync(DB_PATH, { readOnly: true });
const rows = db
  .prepare(
    `SELECT * FROM messages
     WHERE to_handle = '#poker'
     ORDER BY id ASC
     LIMIT ? OFFSET ?`,
  )
  .all(ordinalCount, Math.max(0, ordinalStart - 1));

if (rows.length === 0) {
  console.error(`No #poker messages found at ordinal ${ordinalStart}. DB may be smaller.`);
  process.exit(1);
}

console.log(`Terminal: ${termCols} cols  (watch pane ${watchOpen ? 'OPEN' : 'closed'})`);
console.log(`Pane body budget (contentColumns): ${contentColumns}`);
console.log(`Rendering ${rows.length} messages, ordinals ${ordinalStart}..${ordinalStart + rows.length - 1}`);
console.log('─'.repeat(80));

// Render just MessagesPane against those messages. Wrap it in a fixed-width
// Box that matches the live layout: pane sits inside a bordered container
// with the sidebar + optional watch to its right/left. We simulate available
// pane width = contentColumns + 4 (border + padding on both sides).
const paneWidth = contentColumns + 4;
const { lastFrame } = render(
  React.createElement(Box, { width: paneWidth, flexDirection: 'column' },
    React.createElement(MessagesPane, {
      view: { kind: 'room', room: '#poker' },
      messages: rows,
      meHandle: 'lee',
      focused: true,
      contentColumns,
    }),
  ),
);

const frame = lastFrame() ?? '';
const lines = frame.split('\n');
const overflow = lines
  .map((l, i) => ({ i, len: l.length, l }))
  .filter((r) => r.len > contentColumns);

console.log(`Frame has ${lines.length} lines. Max width: ${Math.max(...lines.map(l => l.length))}`);
if (overflow.length === 0) {
  console.log(`✓ No overflow — all lines within ${contentColumns} cols.`);
} else {
  console.log(`✗ ${overflow.length} lines overflow ${contentColumns}-col budget:`);
  for (const r of overflow.slice(0, 25)) {
    console.log(`  [row ${r.i}] len=${r.len}  ${JSON.stringify(r.l.slice(0, 100))}${r.l.length > 100 ? '…' : ''}`);
  }
}

console.log('─'.repeat(80));
console.log('Sample of the rendered frame (top 40 rows):');
for (let i = 0; i < Math.min(40, lines.length); i++) {
  const mark = lines[i].length > contentColumns ? ' ⚠' : '';
  console.log(`[${String(i).padStart(2)}] len=${String(lines[i].length).padStart(3)}${mark} | ${lines[i]}`);
}
