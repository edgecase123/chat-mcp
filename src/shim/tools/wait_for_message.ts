import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as dao from '../../storage/dao.js';
import type { ShimContext } from '../index.js';
import { toWireMessage } from './inbox.js';

export function installWaitForMessage(server: McpServer, ctx: ShimContext): void {
  server.registerTool(
    'wait_for_message',
    {
      title: 'Block until a message arrives',
      description:
        'Block until at least one message arrives addressed to you, or the timeout expires. Returned messages are marked as read. Use this when you are actively awaiting a reply — fs.watch-driven, so wake-up latency is ~1-5ms. Default timeout is 25s to stay under most MCP client tool-call limits.',
      inputSchema: {
        timeout_s: z
          .number()
          .min(1)
          .max(120)
          .optional()
          .describe('Seconds to wait before returning empty (default 25, max 120)'),
        since_id: z.number().int().optional().describe('Only return messages with id > since_id'),
      },
    },
    async ({ timeout_s, since_id }) => {
      dao.touchLastSeen(ctx.db, ctx.handle);
      const timeoutMs = (timeout_s ?? 25) * 1000;
      const started = Date.now();

      while (true) {
        const pending = dao.pendingInbox(ctx.db, {
          to: ctx.handle,
          ...(since_id !== undefined && { sinceId: since_id }),
        });
        if (pending.length > 0) {
          dao.markRead(ctx.db, pending.map((m) => m.id));
          return {
            content: [{ type: 'text', text: JSON.stringify(pending.map(toWireMessage), null, 2) }],
          };
        }
        const elapsed = Date.now() - started;
        const remaining = timeoutMs - elapsed;
        if (remaining <= 0) break;
        const result = await ctx.notify.waitForNext(remaining);
        if (result === 'timeout') break;
        // Notify fired — loop and re-check DB
      }

      return { content: [{ type: 'text', text: JSON.stringify([]) }] };
    },
  );
}
