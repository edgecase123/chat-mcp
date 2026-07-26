import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import { openDb } from '../storage/db.js';
import { NotifyBus, notifyPeer } from '../notify/bus.js';
import * as dao from '../storage/dao.js';
import type { Message } from '../storage/dao.js';
import { assertRoomName } from '../util/naming.js';
import { bold, cyan, dim, green } from './color.js';

export interface CliOptions {
  handle: string;
}

interface Mode {
  kind: 'top' | 'dm' | 'room';
  dmTarget?: string;
  roomName?: string;
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
  const promptFor = (): string => {
    if (mode.kind === 'dm' && mode.dmTarget) return `${cyan(mode.dmTarget)} > `;
    if (mode.kind === 'room' && mode.roomName) return `${cyan(mode.roomName)} > `;
    return '> ';
  };

  console.log(
    `${bold('chat-mcp')} ${dim('v0.1.0')}  ·  handle: ${cyan(opts.handle)}  ·  ${dim('/help or Ctrl-C to quit')}`,
  );
  rl.setPrompt(promptFor());
  rl.prompt();

  const timeOf = (ts: number): string => new Date(ts).toTimeString().slice(0, 8);

  const printMessage = (m: Message, roomContext?: string): void => {
    // Two-line format. For room messages, insert cyan room name between
    // sender and timestamp so the channel is visible at a glance.
    const ctx = roomContext ? `  ${cyan(roomContext)}` : '';
    const header = `  ${bold(m.from_handle)}${ctx}  ${dim(timeOf(m.sent_at))}`;
    process.stdout.write(`\r\x1b[K\n${header}\n    ${m.body}\n\n`);
    rl.prompt(true);
  };

  const flushInbox = (): void => {
    const dms = dao.pendingInbox(db, { to: opts.handle });
    const roomMsgs = dao.allRoomsUnread(db, opts.handle);
    if (dms.length === 0 && roomMsgs.length === 0) return;

    if (dms.length > 0) {
      const ids = dms.map((m) => m.id);
      dao.markRead(db, ids);
      dao.markDelivered(db, ids);
    }

    // Advance room watermarks by max-id-per-room.
    const maxByRoom = new Map<string, number>();
    for (const m of roomMsgs) {
      const cur = maxByRoom.get(m.to_handle) ?? 0;
      if (m.id > cur) maxByRoom.set(m.to_handle, m.id);
    }
    for (const [r, maxId] of maxByRoom) {
      dao.advanceRoomRead(db, r, opts.handle, maxId);
    }

    type Entry = { m: Message; ctx?: string };
    const merged: Entry[] = [
      ...dms.map((m) => ({ m })),
      ...roomMsgs.map((m) => ({ m, ctx: m.to_handle })),
    ];
    merged.sort((a, b) => a.m.id - b.m.id);
    for (const { m, ctx } of merged) printMessage(m, ctx);
  };

  notify.subscribe(flushInbox);
  flushInbox();

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
          `  ${cyan('/dm')} <handle>      enter DM mode with a peer`,
          `  ${cyan('/rooms')} [--all]    list your rooms (or every room)`,
          `  ${cyan('/join')} #<name>     join a room (auto-creates)`,
          `  ${cyan('/leave')}            leave the current room (removes membership)`,
          `  ${cyan('/back')}             exit DM or room mode (stay a member)`,
          `  ${cyan('/whoami')}           show your own handle`,
          `  ${cyan('/quit')}             exit`,
          dim('  (plain text sends to the current DM target or room)'),
        ].join('\n'));
        break;
      case 'list':
        doList();
        break;
      case 'dm':
        doDm(args[0]);
        break;
      case 'rooms':
        doRooms(args.includes('--all'));
        break;
      case 'join':
        doJoin(args[0]);
        break;
      case 'leave':
        doLeave();
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

  const doRooms = (includeAll: boolean): void => {
    const rooms = includeAll ? dao.allRooms(db) : dao.myRooms(db, opts.handle);
    if (rooms.length === 0) {
      console.log(
        dim(includeAll ? '  (no rooms exist)' : '  (not in any rooms — /rooms --all to discover)'),
      );
      return;
    }
    for (const r of rooms) {
      const name = cyan(r.name.padEnd(16));
      const members = dim(`${r.member_count} member${r.member_count === 1 ? '' : 's'}`);
      console.log(`  ${name}  ${members}`);
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

  const doJoin = (name: string | undefined): void => {
    if (!name) {
      console.log(dim('  usage: /join #<room-name>'));
      return;
    }
    try {
      assertRoomName(name);
    } catch (e) {
      console.log(dim(`  ${(e as Error).message}`));
      return;
    }
    const result = dao.joinRoom(db, name, opts.handle);
    if (result.was_new_member && result.system_message) {
      const members = dao.roomMembers(db, name);
      for (const member of members) {
        if (member === opts.handle) continue;
        notifyPeer(member, {
          id: result.system_message.id,
          to: name,
          from: dao.SYSTEM_HANDLE,
          ts: result.system_message.sent_at,
        });
      }
    }
    mode = { kind: 'room', roomName: name };
    console.log(
      `${cyan('▸')} joined ${cyan(name)}  ${dim(
        `(${result.room.member_count} member${result.room.member_count === 1 ? '' : 's'}, /leave to leave)`,
      )}`,
    );
  };

  const doLeave = (): void => {
    if (mode.kind !== 'room' || !mode.roomName) {
      console.log(dim('  not in a room. /rooms to list.'));
      return;
    }
    const name = mode.roomName;
    dao.leaveRoom(db, name, opts.handle);
    mode = { kind: 'top' };
    console.log(dim(`  left ${name}`));
  };

  const doText = (text: string): void => {
    if (mode.kind === 'dm' && mode.dmTarget) {
      const peer = dao.getAgent(db, mode.dmTarget);
      if (!peer) {
        console.log(dim(`  peer ${mode.dmTarget} no longer registered — /back and try again`));
        return;
      }
      const sent = dao.insertMessage(db, { from: opts.handle, to: mode.dmTarget, body: text });
      notifyPeer(mode.dmTarget, { id: sent.id, to: mode.dmTarget, from: opts.handle, ts: sent.sent_at });
      process.stdout.write(`${dim(`          → sent ${timeOf(sent.sent_at)}`)}\n`);
      return;
    }
    if (mode.kind === 'room' && mode.roomName) {
      const roomName = mode.roomName;
      if (!dao.isRoomMember(db, roomName, opts.handle)) {
        console.log(dim(`  no longer a member of ${roomName} — /back and /join again`));
        return;
      }
      const sent = dao.insertMessage(db, { from: opts.handle, to: roomName, body: text });
      // Advance own watermark so we don't see our own message on next flush.
      dao.advanceRoomRead(db, roomName, opts.handle, sent.id);
      const members = dao.roomMembers(db, roomName);
      for (const member of members) {
        if (member === opts.handle) continue;
        notifyPeer(member, { id: sent.id, to: roomName, from: opts.handle, ts: sent.sent_at });
      }
      process.stdout.write(`${dim(`          → sent ${timeOf(sent.sent_at)}`)}\n`);
      return;
    }
    console.log(dim('  Not in a DM or room. Use /dm <handle> or /join #<room>.'));
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
