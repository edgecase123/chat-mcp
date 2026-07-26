import React from 'react';
import { render } from 'ink';
import { randomUUID } from 'node:crypto';
import { openDb } from '../../storage/db.js';
import { NotifyBus } from '../../notify/bus.js';
import * as dao from '../../storage/dao.js';
import { App } from './App.js';

const VERSION = '0.2.0';

export interface InkCliOptions {
  handle: string;
}

export async function runInkCli(opts: InkCliOptions): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error(
      'chat-mcp cli --experimental needs a real terminal (TTY). ' +
        'Run it directly in your terminal, not through a pipe or non-interactive shell.',
    );
    process.exit(1);
  }

  const db = openDb();
  const notify = new NotifyBus(opts.handle);
  const session_id = randomUUID();

  dao.upsertAgent(db, {
    handle: opts.handle,
    pid: process.pid,
    session_id,
    display_name: opts.handle,
    metadata: { kind: 'human' },
  });

  const { waitUntilExit } = render(
    React.createElement(App, { handle: opts.handle, db, notify, version: VERSION }),
  );

  await waitUntilExit();

  await notify.close();
  try {
    db.close();
  } catch {
    // Best-effort
  }
}
