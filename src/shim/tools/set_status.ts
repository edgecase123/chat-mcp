import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as dao from '../../storage/dao.js';
import type { ShimContext } from '../index.js';

const MAX_FOCUS_LEN = 200;

export function installSetStatus(server: McpServer, ctx: ShimContext): void {
  server.registerTool(
    'set_status',
    {
      title: 'Set your live status + focus',
      description:
        'Update this agent\'s coordination status so the human operator (and sibling agents) can see what you are doing at a glance. Status is one of: idle, thinking, tool, blocked, error, offline. Focus is an optional one-line description of what you are currently working on (max 200 chars). Both are visible in the CLI sidebar.',
      inputSchema: {
        status: z
          .enum(['idle', 'thinking', 'tool', 'blocked', 'error', 'offline'])
          .describe('Live status'),
        focus: z
          .string()
          .max(MAX_FOCUS_LEN)
          .optional()
          .describe('One-line description of current work. Pass empty string or omit to clear.'),
      },
    },
    async ({ status, focus }) => {
      const clean = focus && focus.length > 0 ? focus : null;
      dao.setAgentStatus(ctx.db, ctx.handle, status, clean);
      return {
        content: [{ type: 'text', text: JSON.stringify({ status, focus: clean }) }],
      };
    },
  );
}
