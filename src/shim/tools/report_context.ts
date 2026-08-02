import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as dao from '../../storage/dao.js';
import { notifyPeer } from '../../notify/bus.js';
import { nextGaugeState, warningBody, type Threshold } from '../gauge.js';
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
      if (used > total) {
        throw new Error(`report_context: used (${used}) must not exceed total (${total})`);
      }
      const me = dao.getAgent(ctx.db, ctx.handle);
      const prevWarned = (me?.context_warned_threshold ?? null) as Threshold | null;
      dao.setAgentContext(ctx.db, ctx.handle, used, total);

      const percent = total > 0 ? Math.round((used / total) * 1000) / 10 : 0;
      const transition = nextGaugeState(percent, prevWarned);

      if (transition.next_warned !== prevWarned) {
        dao.setAgentContextWarned(ctx.db, ctx.handle, transition.next_warned);
      }

      const notified = { dm: 0, rooms: [] as string[] };
      if (transition.fire != null) {
        const body = warningBody(ctx.handle, transition.fire, percent);
        if (transition.fire === 70) {
          // Soft warning: DM the peer only. The peer's own client renders
          // this in their inbox; no room chatter yet.
          const result = dao.insertMessage(ctx.db, {
            from: dao.SYSTEM_HANDLE,
            to: ctx.handle,
            body,
            kind: 'chat',
          });
          notifyPeer(ctx.handle, {
            id: result.id,
            to: ctx.handle,
            from: dao.SYSTEM_HANDLE,
            ts: result.sent_at,
          });
          notified.dm = 1;
        } else {
          // 85 / 95: post to every room the peer is a member of so co-agents
          // + the human can react. Kind='alert' at 95 so it surfaces in the
          // alert lane.
          const kind = transition.fire === 95 ? 'alert' : 'chat';
          for (const room of dao.myRooms(ctx.db, ctx.handle)) {
            const result = dao.insertMessage(ctx.db, {
              from: dao.SYSTEM_HANDLE,
              to: room.name,
              body,
              kind,
            });
            for (const member of dao.roomMembers(ctx.db, room.name)) {
              notifyPeer(member, {
                id: result.id,
                to: room.name,
                from: dao.SYSTEM_HANDLE,
                ts: result.sent_at,
              });
            }
            notified.rooms.push(room.name);
          }
        }
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              used,
              total,
              percent,
              reported_at: Date.now(),
              warned: transition.next_warned,
              fired: transition.fire,
              notified,
            }),
          },
        ],
      };
    },
  );
}
