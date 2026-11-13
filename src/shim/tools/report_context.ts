import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { applyContextReport } from '../gauge-report.js';
import type { ShimContext } from '../index.js';

export function installReportContext(server: McpServer, ctx: ShimContext): void {
  server.registerTool(
    'report_context',
    {
      title: 'Report your context-window usage',
      description:
        "Push this agent's current context-window usage so sibling peers and the human can see who is running low on space. `used` and `total` are integers in this agent's own tokenizer — the bus stores both and other tools compute percentages (used/total). Report on a cadence that fits your client (every N tool calls, or on a >5% delta). Crossing the 70% / 85% / 95% bands emits a warning message (soft DM at 70, room-post at 85, room-post + alert at 95); hysteresis at −5% under each band prevents chatter. Not calling this simply leaves the gauge unknown; there is no penalty.",
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
      // ⚠️ REFUSED, NOT CLAMPED. The hook clamps because it must not throw
      // inside a PreToolUse; an agent calling this directly is told instead.
      if (used > total) {
        throw new Error(`report_context: used (${used}) must not exceed total (${total})`);
      }

      const report = applyContextReport(ctx.db, ctx.handle, used, total);

      return {
        content: [
          { type: 'text', text: JSON.stringify({ ...report, reported_at: Date.now() }) },
        ],
      };
    },
  );
}
