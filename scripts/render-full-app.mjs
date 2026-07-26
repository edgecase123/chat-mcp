#!/usr/bin/env node
// Full-App headless render into a mock stdout so I can see exactly what
// Ink emits for the entire layout, WITHOUT the alt-screen dance.

import React from 'react';
import { render } from 'ink-testing-library';

// Force a controlled stdout size before importing anything Ink-related.
process.stdout.columns = 140;
process.stdout.rows = 30;

const { App } = await import('../dist/cli/ink/App.js');
const { openDb } = await import('../dist/storage/db.js');
const dao = await import('../dist/storage/dao.js');
const { NotifyBus } = await import('../dist/notify/bus.js');

const db = openDb();
const notify = new NotifyBus('claude2');

// Seed a couple of DM messages with varying body shapes — this is the case
// the user screenshot showed breaking.
dao.upsertAgent(db, { handle: 'claude2', pid: process.pid, session_id: 'render-smoke', display_name: 'claude2', metadata: { kind: 'human' } });

const { lastFrame } = render(
  React.createElement(App, { handle: 'claude2', db, notify, version: '0.3.0' }),
);

// Give effects a tick, then dump.
await new Promise((r) => setTimeout(r, 200));

const out = lastFrame() ?? '(no frame)';
out.split('\n').forEach((line, i) => {
  process.stdout.write(String(i + 1).padStart(3) + '│' + line + '\n');
});

notify.close();
db.close();
process.exit(0);
