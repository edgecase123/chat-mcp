import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import { openDb } from '../storage/db.js';
import { NotifyBus, notifyPeer } from '../notify/bus.js';
import * as dao from '../storage/dao.js';
import type { Message } from '../storage/dao.js';
import { bold, cyan, dim, green } from './color.js';

export interface CliOptions {
  handle: string;
}

interface Mode {
  kind: 'top' | 'dm';
  dmTarget?: string;
}

export async function runCli(opts: CliOptions): Promise<void> {
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

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  let mode: Mode = { kind: 'top' };
  const promptFor = (): string =>
    mode.kind === 'dm' && mode.dmTarget ? `${cyan(mode.dmTarget)} > ` : '> ';

  console.log(
    `${bold('chat-mcp')} ${dim('v0.0.1')}  ·  handle: ${cyan(opts.handle)}  ·  ${dim('/help or Ctrl-C to quit')}`,
  );
  rl.setPrompt(promptFor());
  rl.prompt();

  const timeOf = (ts: number): string => new Date(ts).toTimeString().slice(0, 8);

  const printMessage = (m: Message): void => {
    // Clear the current input line, print above it, then redraw prompt + buffer.
    // Two-line format: bold sender + dim timestamp header, then indented body,
    // with a leading + trailing blank line to separate conversation turns.
    const header = `  ${bold(m.from_handle)}  ${dim(timeOf(m.sent_at))}`;
    process.stdout.write(`\r\x1b[K\n${header}\n    ${m.body}\n\n`);
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
    console.log(dim('bye'));
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
          `  ${cyan('/list')}             list online peers`,
          `  ${cyan('/dm')} <handle>      enter DM mode`,
          `  ${cyan('/back')}             leave DM mode`,
          `  ${cyan('/whoami')}           show your own handle`,
          `  ${cyan('/quit')}             exit`,
          dim(`  (plain text in DM mode sends to the current DM target)`),
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
        console.log(`  handle: ${cyan(opts.handle)}  ${dim(`session_id: ${session_id}`)}`);
        break;
      case 'quit':
      case 'exit':
        cleanup();
        return;
      default:
        console.log(dim(`  unknown command: /${cmd} (try /help)`));
    }
  };

  const doList = (): void => {
    const agents = dao.listAgents(db, false).filter((a) => a.handle !== opts.handle);
    if (agents.length === 0) {
      console.log(dim('  (no peers online)'));
      return;
    }
    for (const a of agents) {
      const name = bold(a.handle.padEnd(12));
      const kind = a.kind.padEnd(6);
      const status = green('online');
      const seen = dim(`seen ${timeOf(a.last_seen_at)}`);
      console.log(`  ${name}  ${kind}  ${status}  ${seen}`);
    }
  };

  const doDm = (target: string | undefined): void => {
    if (!target) {
      console.log(dim('  usage: /dm <handle>'));
      return;
    }
    if (target === opts.handle) {
      console.log(dim('  cannot dm yourself'));
      return;
    }
    const peer = dao.getAgent(db, target);
    if (!peer) {
      console.log(dim(`  unknown peer: ${target}`));
      return;
    }
    mode = { kind: 'dm', dmTarget: target };
    console.log(`${cyan('▸')} dm with ${cyan(target)}  ${dim('(/back to leave)')}`);
  };

  const doText = (text: string): void => {
    if (mode.kind !== 'dm' || !mode.dmTarget) {
      console.log(dim('  Not in a DM. Use /dm <handle> first (/list to see peers).'));
      return;
    }
    const peer = dao.getAgent(db, mode.dmTarget);
    if (!peer) {
      console.log(dim(`  peer ${mode.dmTarget} no longer registered — /back and try again`));
      return;
    }
    const sent = dao.insertMessage(db, { from: opts.handle, to: mode.dmTarget, body: text });
    notifyPeer(mode.dmTarget, { id: sent.id, to: mode.dmTarget, from: opts.handle, ts: sent.sent_at });
    // Own send: skip echoing the body (readline already showed it) and just
    // print a dim timestamp confirmation aligned under the prompt.
    process.stdout.write(`${dim(`          → sent ${timeOf(sent.sent_at)}`)}\n`);
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
      console.log(dim(`  error: ${err.message}`));
    }
    if (!closing) {
      rl.setPrompt(promptFor());
      rl.prompt();
    }
  });
  rl.on('SIGINT', cleanup);
  rl.on('close', cleanup);
}
