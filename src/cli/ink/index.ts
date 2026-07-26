import React from 'react';
import { render } from 'ink';
import { randomUUID } from 'node:crypto';
import { openDb } from '../../storage/db.js';
import { NotifyBus } from '../../notify/bus.js';
import * as dao from '../../storage/dao.js';
import { App } from './App.js';

const VERSION = '0.3.0';

/** DEC private-mode sequence: enter alternate screen buffer (save cursor +
 *  switch to a fresh scroll region so the app owns the visible viewport and
 *  does not pollute the user's terminal scrollback). */
const ENTER_ALT_SCREEN = '\x1b[?1049h';
/** Restore original scrollback + cursor. */
const EXIT_ALT_SCREEN = '\x1b[?1049l';

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

  // Full-screen: switch to alternate buffer so the Ink app doesn't scroll
  // frames into the terminal's history. Register cleanup on every reasonable
  // exit path — normal exit, Ctrl-C, kill, uncaught error.
  process.stdout.write(ENTER_ALT_SCREEN);
  let exited = false;
  const restoreTerminal = (): void => {
    if (exited) return;
    exited = true;
    process.stdout.write(EXIT_ALT_SCREEN);
  };
  process.on('exit', restoreTerminal);
  process.on('SIGINT', () => { restoreTerminal(); process.exit(130); });
  process.on('SIGTERM', () => { restoreTerminal(); process.exit(143); });
  process.on('uncaughtException', (err) => {
    restoreTerminal();
    console.error(err);
    process.exit(1);
  });

  try {
    const { waitUntilExit } = render(
      React.createElement(App, { handle: opts.handle, db, notify, version: VERSION }),
    );

    await waitUntilExit();
  } finally {
    restoreTerminal();
    await notify.close();
    try {
      db.close();
    } catch {
      // Best-effort
    }
  }
}
