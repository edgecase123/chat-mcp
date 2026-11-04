import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as dao from '../../storage/dao.js';
import { gaugeFreshness } from '../gauge-freshness.js';
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
      // One clock reading for the whole response, so two agents in the same
      // payload are never aged against different "now"s.
      const now = Date.now();

      const result = agents.map((a) => ({
        handle: a.handle,
        display_name: a.display_name,
        kind: a.kind,
        online: a.online,
        last_seen_at: a.last_seen_at,
        status: a.status,
        focus: a.focus,
        status_updated_at: a.status_updated_at,
        context_used: a.context_used,
        context_total: a.context_total,
        context_reported_at: a.context_reported_at,
        // #103 — a reading this old has stopped describing the agent. Emitted
        // beside the number so a reader cannot take a frozen gauge as live,
        // which is what both agents did for 28 days.
        ...gaugeFreshness(a.context_reported_at, now),
        context_warned_threshold: a.context_warned_threshold,
      }));
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    },
  );
}
