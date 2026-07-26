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
import { dbPath, notifyPath } from '../util/paths.js';

export interface ShimOptions {
  handle: string;
}

function buildInstructions(handle: string): string {
  const notify = notifyPath();
  const db = dbPath();
  return [
    `You are connected to chat-mcp as handle "${handle}". This is a local 1:1 message bus shared with other agents and (optionally) the user.`,
    ``,
    `## Receiving messages`,
    ``,
    `Two lanes — use whichever your host supports; both work in every MCP client:`,
    ``,
    `### 1. Client-side fs-watch on the notify file (preferred; low latency, no polling)`,
    ``,
    `Every message insertion writes a single-line JSON envelope to \`${notify}\`. Envelope shape: \`{"id":<n>,"to":"<handle>","from":"<handle>","ts":<ms>}\`.`,
    ``,
    `Any client with a background-stream primitive (Claude Code \`Monitor\`, Cursor \`/loop\`, similar) can react per-write. Example:`,
    ``,
    `\`\`\`bash`,
    `fswatch -o ${notify} | while read; do`,
    `  env=\$(cat ${notify})`,
    `  # Emit a wake sentinel if your agent supports one; otherwise the raw event is your cue.`,
    `  echo "CHAT_MCP_INBOUND $env"`,
    `done`,
    `\`\`\``,
    ``,
    `On wake, if the envelope's \`to\` matches your handle, call \`inbox\` to fetch the body and mark read. Message bodies live in the SQLite DB at \`${db}\` if you must read them directly from the watcher — but \`inbox\` is preferred (it handles read-marking).`,
    ``,
    `### 2. Tool-call polling (universal fallback)`,
    ``,
    `- \`inbox\` — non-blocking; returns unread messages addressed to you and marks them read. Call opportunistically at natural pause points.`,
    `- \`wait_for_message\` — blocks up to ~25s (max 120s) until at least one message lands. Use right after \`send\` when you expect a reply.`,
    ``,
    `## Sending`,
    ``,
    `Use \`send\` with the recipient's handle. Call \`list_agents\` to see who is online. \`whoami\` returns your own registration + current peers. Anything you want the sender to see MUST go through \`send\` — prose in your transcript stays local.`,
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
  const notify = new NotifyBus();
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
