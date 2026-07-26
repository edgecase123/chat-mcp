import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { randomUUID } from 'node:crypto';
import type { Database as Db } from 'better-sqlite3';
import { openDb } from '../storage/db.js';
import { NotifyBus } from '../notify/bus.js';
import * as dao from '../storage/dao.js';
import { installWhoami } from './tools/whoami.js';
import { installRegister } from './tools/register.js';
import { installListAgents } from './tools/list_agents.js';
import { installSend } from './tools/send.js';
import { installInbox } from './tools/inbox.js';
import { installWaitForMessage } from './tools/wait_for_message.js';
import { installInboxResource } from './resources/inbox.js';
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
    `## ⚠️ REQUIRED FIRST STEP — subscribe to your notify file`,
    ``,
    `Before doing anything else this session, arm a background watch on your notify file:`,
    ``,
    `  ${myNotify}`,
    ``,
    `Every write to that file = a new message addressed to you. Without an active subscription, incoming messages sit unread until you happen to call \`inbox\` — which may be never. **Missed messages from your human's other agents look identical to "the other agent didn't reply." Do not skip this step, even if the user's first request looks unrelated to chat.**`,
    ``,
    `### Claude Code — call \`Monitor\` now with these exact arguments`,
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
    `The node one-liner emits one stdout line per write to the file → one Monitor notification per inbound message. Node is already required to run chat-mcp, so this has zero extra deps. On each notification, call \`inbox\` to fetch bodies and mark them read.`,
    ``,
    `(If you prefer \`fswatch\` and have it installed: \`fswatch -o ${myNotify}\` works identically. \`fswatch\` is NOT part of macOS base — it's a Homebrew package — so don't assume it's available.)`,
    ``,
    `### Other clients with a background-stream primitive`,
    ``,
    `Cursor \`/loop\`, similar fswatch-loop-wake, etc.: same idea — watch \`${myNotify}\` and on each write, call \`inbox\`. Each write is a single-line JSON envelope: \`{"id":<n>,"to":"${handle}","from":"<sender>","ts":<ms>}\` (future fields may appear — treat unknown fields as opaque).`,
    ``,
    `### Fallback — no background primitive available`,
    ``,
    `If your client can't watch files in the background, poll:`,
    ``,
    `- \`inbox\` — non-blocking; returns unread messages and marks them read. Call at every natural pause point (after each tool result, before answering).`,
    `- \`wait_for_message\` — blocks up to ~25s (max 120s). Use right after \`send\` when you expect a reply.`,
    ``,
    `Message bodies also live in the SQLite DB at \`${db}\` if you must read directly, but \`inbox\` is preferred (it handles read-marking).`,
    ``,
    `## Sending`,
    ``,
    `Use \`send\` with the recipient's handle. Call \`list_agents\` to see who is online. \`whoami\` returns your own registration + \`notify_path\` + current peers. Anything you want the sender to see MUST go through \`send\` — prose in your transcript stays local.`,
  ].join('\n');
}

export interface ShimContext {
  handle: string;
  session_id: string;
  db: Db;
  notify: NotifyBus;
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

  const ctx: ShimContext = { handle: opts.handle, session_id, db, notify };
  const server = new McpServer(
    { name: 'chat-mcp', version: '0.0.1' },
    { instructions: buildInstructions(opts.handle) },
  );

  installWhoami(server, ctx);
  installRegister(server, ctx);
  installListAgents(server, ctx);
  installSend(server, ctx);
  installInbox(server, ctx);
  installWaitForMessage(server, ctx);
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
