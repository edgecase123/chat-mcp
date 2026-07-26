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
    `## Reading and sending`,
    ``,
    `- \`inbox\` — non-blocking; returns unread messages and marks them read. Call on each wake, and at natural pause points if wake isn't wired up.`,
    `- \`wait_for_message\` — blocks up to ~25s (max 120s). Use right after \`send\` when you expect a fast reply.`,
    `- \`send\` — send a 1:1 message. \`list_agents\` shows who is online. \`whoami\` returns your own registration + peers.`,
    ``,
    `Anything you want a peer to see MUST go through \`send\` — prose in your local transcript stays local. Message bodies also live in the SQLite DB at \`${db}\` if you must read directly, but \`inbox\` is preferred (it handles read-marking).`,
    ``,
    `Each write to the notify file is a single-line JSON envelope: \`{"id":<n>,"to":"${handle}","from":"<sender>","ts":<ms>}\` — treat unknown fields as opaque.`,
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
