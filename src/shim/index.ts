import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { randomUUID } from 'node:crypto';
import { openDb, type Db } from '../storage/db.js';
import { NotifyBus } from '../notify/bus.js';
import * as dao from '../storage/dao.js';
import { installWhoami } from './tools/whoami.js';
import { installRegister } from './tools/register.js';
import { installListAgents } from './tools/list_agents.js';
import { installSend } from './tools/send.js';
import { installInbox } from './tools/inbox.js';
import { installWaitForMessage } from './tools/wait_for_message.js';
import { installRoomJoin } from './tools/room_join.js';
import { installRoomLeave } from './tools/room_leave.js';
import { installRoomSend } from './tools/room_send.js';
import { installRoomInbox } from './tools/room_inbox.js';
import { installRoomList } from './tools/room_list.js';
import { installRoomMembers } from './tools/room_members.js';
import { installSetStatus } from './tools/set_status.js';
import { installInboxResource } from './resources/inbox.js';
import { checkWakeAdapter, prependAdapterWarning, type AdapterStatus } from './adapter-check.js';
import { dbPath, notifyPathFor } from '../util/paths.js';

export interface ShimOptions {
  handle: string;
}

function buildInstructions(handle: string): string {
  const myNotify = notifyPathFor(handle);
  const db = dbPath();
  return [
    `You are connected to chat-mcp as handle "${handle}". This is a local 1:1 message bus shared with other agents and (optionally) the user.`,
    ``,
    `## Wake mechanism`,
    ``,
    `Incoming messages write to \`${myNotify}\`. Your agent framework needs an external wake trigger to react to these writes while the model is idle. Two paths:`,
    ``,
    `**Zero-config (recommended):** the human operator runs the framework adapter installer once per handle:`,
    ``,
    `\`\`\`bash`,
    `npx -y github:edgecase123/chat-mcp install <framework> --handle ${handle}`,
    `\`\`\``,
    ``,
    `Supported frameworks: \`claude-code\`. Others (cursor, codex, gemini-cli) planned. Run \`chat-mcp list-adapters\` to see the current set. If you're the agent reading this and no adapter is installed for your framework, tell the user the single command above and stop.`,
    ``,
    `**Manual fallback (Claude Code):** if no adapter is installed, arm the watch yourself as your first tool call:`,
    ``,
    `\`\`\`json`,
    `{`,
    `  "command": "node -e \\"require('fs').watch('${myNotify}', () => console.log('wake'))\\"",`,
    `  "description": "chat-mcp inbound for ${handle}",`,
    `  "persistent": true,`,
    `  "timeout_ms": 3600000`,
    `}`,
    `\`\`\``,
    ``,
    `## Reading and sending — direct messages`,
    ``,
    `- \`inbox\` — non-blocking; returns unread DMs and marks them read. Call on each wake, and at natural pause points if wake isn't wired up.`,
    `- \`wait_for_message\` — blocks up to ~25s (max 120s). Use right after \`send\` when you expect a fast reply.`,
    `- \`send\` — send a 1:1 message. \`list_agents\` shows who is online. \`whoami\` returns your own registration + peers.`,
    ``,
    `## Rooms — multi-peer channels`,
    ``,
    `Rooms are named channels prefixed with \`#\` (e.g. \`#gate\`, \`#planning\`). Only current members receive messages sent to a room. Membership is explicit and persistent across sessions.`,
    ``,
    `- \`room_join\` — join a room (auto-creates on first join). Pre-join history stays hidden.`,
    `- \`room_leave\` — leave; drops membership.`,
    `- \`room_send\` — post to a room you're a member of. Notifies every currently-online member.`,
    `- \`room_inbox\` — read unread messages, per-member watermark. Pass a specific \`room\` or omit to read across all your rooms.`,
    `- \`room_list\` — rooms you're in (or \`include_all=true\` to discover).`,
    `- \`room_members\` — handles currently in a specific room (offline members included).`,
    ``,
    `Room-message notify envelope: \`{"id":<n>,"to":"#roomname","from":"<sender>","ts":<ms>}\`. The wake mechanism doesn't distinguish DMs from rooms — call \`inbox\` AND \`room_inbox\` (or wire both into your handler) on each wake.`,
    ``,
    `Anything you want a peer to see MUST go through \`send\` or \`room_send\` — prose in your local transcript stays local. Message bodies also live in the SQLite DB at \`${db}\` if you must read directly, but the inbox tools are preferred (they handle read-marking).`,
    ``,
    `Each write to a notify file is a single-line JSON envelope. \`to\` carries either your handle (DM) or a \`#room\` name — treat unknown fields as opaque.`,
  ].join('\n');
}

export interface ShimContext {
  handle: string;
  session_id: string;
  db: Db;
  notify: NotifyBus;
  adapterStatus: AdapterStatus;
}

export async function runShim(opts: ShimOptions): Promise<void> {
  const db = openDb();
  const notify = new NotifyBus(opts.handle);
  const session_id = randomUUID();

  dao.upsertAgent(db, {
    handle: opts.handle,
    pid: process.pid,
    session_id,
    display_name: opts.handle,
    metadata: { kind: 'agent' },
  });

  const adapterStatus = checkWakeAdapter(opts.handle);
  const ctx: ShimContext = { handle: opts.handle, session_id, db, notify, adapterStatus };
  const server = new McpServer(
    { name: 'chat-mcp', version: '0.2.0' },
    { instructions: prependAdapterWarning(buildInstructions(opts.handle), adapterStatus) },
  );

  installWhoami(server, ctx);
  installRegister(server, ctx);
  installListAgents(server, ctx);
  installSend(server, ctx);
  installInbox(server, ctx);
  installWaitForMessage(server, ctx);
  installRoomJoin(server, ctx);
  installRoomLeave(server, ctx);
  installRoomSend(server, ctx);
  installRoomInbox(server, ctx);
  installRoomList(server, ctx);
  installRoomMembers(server, ctx);
  installSetStatus(server, ctx);
  installInboxResource(server, ctx);

  const transport = new StdioServerTransport();

  let cleaningUp = false;
  const cleanup = async (): Promise<void> => {
    if (cleaningUp) return;
    cleaningUp = true;
    try {
      await server.close();
    } catch {
      // Best-effort — transport may already be gone
    }
    await notify.close();
    try {
      db.close();
    } catch {
      // Same as above
    }
    process.exit(0);
  };

  transport.onclose = () => {
    void cleanup();
  };
  process.on('SIGINT', () => void cleanup());
  process.on('SIGTERM', () => void cleanup());

  await server.connect(transport);
}
