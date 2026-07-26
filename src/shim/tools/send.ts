import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as dao from '../../storage/dao.js';
import { notifyPeer } from '../../notify/bus.js';
import type { ShimContext } from '../index.js';

const MAX_BODY_BYTES = 64 * 1024;

export function installSend(server: McpServer, ctx: ShimContext): void {
  server.registerTool(
    'send',
    {
      title: 'Send a 1:1 message to a peer',
      description:
        'Send a message to another peer on the chat bus. body is UTF-8 text, max 64 KB. The recipient must be a known peer (call list_agents first if unsure).',
      inputSchema: {
        to: z.string().describe('Handle of the recipient peer'),
        body: z.string().describe('Message body (UTF-8, max 64 KB)'),
        kind: z
          .enum(['chat', 'dispatch', 'alert'])
          .optional()
          .describe('Coordination kind. "chat" (default) is a normal message. "dispatch" tags this as a task hand-off. "alert" tags it as blocking/high-severity and surfaces it in the recipient CLI\'s alert lane.'),
      },
    },
    async ({ to, body, kind }) => {
      if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
        throw new Error(`Message body exceeds ${MAX_BODY_BYTES}-byte cap`);
      }
      if (to === ctx.handle) {
        throw new Error('Cannot send to self');
      }
      const recipient = dao.getAgent(ctx.db, to);
      if (!recipient) {
        throw new Error(`Unknown peer: ${to}. Call list_agents to see who is registered.`);
      }
      dao.touchLastSeen(ctx.db, ctx.handle);
      const result = dao.insertMessage(ctx.db, { from: ctx.handle, to, body, kind });
      notifyPeer(to, { id: result.id, to, from: ctx.handle, ts: result.sent_at });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ message_id: result.id, sent_at: result.sent_at }),
          },
        ],
      };
    },
  );
}
