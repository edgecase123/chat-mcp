import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as dao from '../../storage/dao.js';
import type { Message } from '../../storage/dao.js';
import type { ShimContext } from '../index.js';

export function installInbox(server: McpServer, ctx: ShimContext): void {
  server.registerTool(
    'inbox',
    {
      title: 'Read pending messages',
      description:
        'Read all pending (unread) messages addressed to you and mark them as read. Cheap; call whenever you want to check for new mail. Use wait_for_message instead when you want to block until a message arrives.',
      inputSchema: {
        since_id: z.number().int().optional().describe('Only return messages with id > since_id'),
        limit: z.number().int().min(1).max(500).optional().describe('Max messages to return (default 50)'),
      },
    },
    async ({ since_id, limit }) => {
      dao.touchLastSeen(ctx.db, ctx.handle);
      const messages = dao.pendingInbox(ctx.db, {
        to: ctx.handle,
        ...(since_id !== undefined && { sinceId: since_id }),
        ...(limit !== undefined && { limit }),
      });
      if (messages.length > 0) {
        dao.markRead(ctx.db, messages.map((m) => m.id));
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(messages.map(toWireMessage), null, 2) }],
      };
    },
  );
}

export function toWireMessage(m: Message): { id: number; from: string; body: string; sent_at: number } {
  return { id: m.id, from: m.from_handle, body: m.body, sent_at: m.sent_at };
}
