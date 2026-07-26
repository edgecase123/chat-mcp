import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import type { Database as Db } from 'better-sqlite3';
import { openDb } from '../storage/db.js';
import { NotifyBus } from '../notify/bus.js';
import * as dao from '../storage/dao.js';
import type { Message } from '../storage/dao.js';

export interface CliOptions {
  handle: string;
}

interface Mode {
  kind: 'top' | 'dm';
  dmTarget?: string;
}

export async function runCli(opts: CliOptions): Promise<void> {
  const db = openDb();
  const notify = new NotifyBus();
  const session_id = randomUUID();

  dao.upsertAgent(db, {
    handle: opts.handle,
    pid: process.pid,
    session_id,
    display_name: opts.handle,
    metadata: { kind: 'human' },
  });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  let mode: Mode = { kind: 'top' };
  const promptFor = (): string => (mode.kind === 'dm' ? `[dm ${mode.dmTarget}] > ` : '> ');

  console.log(`chat-mcp v0.0.1 · handle: ${opts.handle} · type /help or Ctrl-C to quit`);
  rl.setPrompt(promptFor());
  rl.prompt();

  const timeOf = (ts: number): string => new Date(ts).toTimeString().slice(0, 8);

  const printMessage = (m: Message): void => {
    // Clear the current input line, print above it, then redraw prompt + buffer
    process.stdout.write(`\r\x1b[K[${m.from_handle} → ${opts.handle} ${timeOf(m.sent_at)}]  ${m.body}\n`);
    rl.prompt(true);
  };

  const flushPending = (): void => {
    const pending = dao.pendingInbox(db, { to: opts.handle });
    if (pending.length === 0) return;
    dao.markRead(db, pending.map((m) => m.id));
    dao.markDelivered(db, pending.map((m) => m.id));
    for (const m of pending) printMessage(m);
  };

  notify.subscribe(flushPending);
  flushPending();

  let closing = false;
  const cleanup = (): void => {
    if (closing) return;
    closing = true;
    console.log('bye');
    rl.close();
    void notify.close().finally(() => {
      try {
        db.close();
      } catch {
        // Best-effort
      }
      process.exit(0);
    });
  };

  const doCommand = (line: string): void => {
    const parts = line.slice(1).split(/\s+/);
    const cmd = parts[0] ?? '';
    const args = parts.slice(1);
    switch (cmd) {
      case 'help':
        console.log([
          '/list             — list online peers',
          '/dm <handle>      — enter DM mode with a peer',
          '/back             — leave DM mode',
          '/whoami           — show your own handle',
          '/quit             — exit',
          '(plain text in DM mode is sent to the current DM target)',
        ].join('\n'));
        break;
      case 'list':
        doList();
        break;
      case 'dm':
        doDm(args[0]);
        break;
      case 'back':
        mode = { kind: 'top' };
        break;
      case 'whoami':
        console.log(`handle: ${opts.handle} · session_id: ${session_id}`);
        break;
      case 'quit':
      case 'exit':
        cleanup();
        return;
      default:
        console.log(`unknown command: /${cmd} (try /help)`);
    }
  };

  const doList = (): void => {
    const agents = dao.listAgents(db, false).filter((a) => a.handle !== opts.handle);
    if (agents.length === 0) {
      console.log('(no peers online)');
      return;
    }
    for (const a of agents) {
      const name = a.handle.padEnd(16);
      const kind = a.kind.padEnd(6);
      const seen = timeOf(a.last_seen_at);
      console.log(`  ${name}· ${kind}· online · last seen ${seen}`);
    }
  };

  const doDm = (target: string | undefined): void => {
    if (!target) {
      console.log('usage: /dm <handle>');
      return;
    }
    if (target === opts.handle) {
      console.log('cannot dm yourself');
      return;
    }
    const peer = dao.getAgent(db, target);
    if (!peer) {
      console.log(`unknown peer: ${target}`);
      return;
    }
    mode = { kind: 'dm', dmTarget: target };
    console.log(`[dm with ${target}]  (type to send, /back to return, /quit to exit)`);
  };

  const doText = (text: string): void => {
    if (mode.kind !== 'dm' || !mode.dmTarget) {
      console.log('Not in a DM. Use /dm <handle> first (/list to see peers).');
      return;
    }
    const peer = dao.getAgent(db, mode.dmTarget);
    if (!peer) {
      console.log(`peer ${mode.dmTarget} no longer registered — /back and try again`);
      return;
    }
    dao.insertMessage(db, { from: opts.handle, to: mode.dmTarget, body: text });
    notify.touch();
    const now = new Date().toTimeString().slice(0, 8);
    process.stdout.write(`\r\x1b[K[${opts.handle} → ${mode.dmTarget} ${now}]  ${text}\n`);
  };

  rl.on('line', (raw: string) => {
    const line = raw.trimEnd();
    if (line.length === 0) {
      rl.setPrompt(promptFor());
      rl.prompt();
      return;
    }
    try {
      if (line.startsWith('/')) {
        doCommand(line);
      } else {
        doText(line);
      }
    } catch (e) {
      const err = e as Error;
      console.log(`error: ${err.message}`);
    }
    if (!closing) {
      rl.setPrompt(promptFor());
      rl.prompt();
    }
  });
  rl.on('SIGINT', cleanup);
  rl.on('close', cleanup);
}
