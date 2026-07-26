import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as dao from '../../storage/dao.js';
import type { ShimContext } from '../index.js';

export function installListAgents(server: McpServer, ctx: ShimContext): void {
  server.registerTool(
    'list_agents',
    {
      title: 'List peers on the chat bus',
      description:
        'List peers on the chat bus, including their kind (agent, human, etc.) and online status. By default returns only online peers; pass include_offline=true to see everyone the bus has ever known.',
      inputSchema: {
        include_offline: z.boolean().optional().describe('Include peers whose shim process is no longer alive'),
      },
    },
    async ({ include_offline }) => {
      dao.touchLastSeen(ctx.db, ctx.handle);
      const agents = dao.listAgents(ctx.db, include_offline ?? false);
      const result = agents.map((a) => ({
        handle: a.handle,
        display_name: a.display_name,
        kind: a.kind,
        online: a.online,
        last_seen_at: a.last_seen_at,
      }));
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    },
  );
}
