import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as dao from '../../storage/dao.js';
import type { ShimContext } from '../index.js';

export function installReportContext(server: McpServer, ctx: ShimContext): void {
  server.registerTool(
    'report_context',
    {
      title: 'Report your context-window usage',
      description:
        "Push this agent's current context-window usage so sibling peers and the human can see who is running low on space. `used` and `total` are integers in this agent's own tokenizer — the bus stores both and other tools compute percentages (used/total). Report on a cadence that fits your client (every N tool calls, or on a >5% delta). Not calling this simply leaves the gauge unknown; there is no penalty. Later slices layer threshold-crossing room posts on top of these reports; this tool is the storage primitive.",
      inputSchema: {
        used: z
          .number()
          .int()
          .min(0)
          .describe("Tokens currently consumed in this agent's context window."),
        total: z
          .number()
          .int()
          .positive()
          .describe("Total context-window size for this agent's model (e.g. 200000, 1000000)."),
      },
    },
    async ({ used, total }) => {
      if (used > total) {
        throw new Error(`report_context: used (${used}) must not exceed total (${total})`);
      }
      dao.setAgentContext(ctx.db, ctx.handle, used, total);
      const percent = total > 0 ? Math.round((used / total) * 1000) / 10 : 0;
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ used, total, percent, reported_at: Date.now() }),
          },
        ],
      };
    },
  );
}
