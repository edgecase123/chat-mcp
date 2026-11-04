import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as dao from '../../storage/dao.js';
import { gaugeFreshness } from '../gauge-freshness.js';
import { notifyPathFor } from '../../util/paths.js';
import type { ShimContext } from '../index.js';

export function installWhoami(server: McpServer, ctx: ShimContext): void {
  server.registerTool(
    'whoami',
    {
      title: 'Who am I on the chat bus?',
      description:
        "Return this shim's handle, session_id, kind, and the current list of online peers. Cheap self-discovery — call this after your MCP client starts to confirm you're registered and see who else is available.",
      inputSchema: {},
    },
    async () => {
      dao.touchLastSeen(ctx.db, ctx.handle);
      const me = dao.getAgent(ctx.db, ctx.handle);
      if (!me) throw new Error(`Agent row missing for handle=${ctx.handle}`);
      const peers = dao.listAgents(ctx.db, false).filter((a) => a.handle !== ctx.handle);
      // One clock reading for the whole response, so two agents in the same
      // payload are never aged against different "now"s.
      const now = Date.now();

      const result = {
        handle: me.handle,
        display_name: me.display_name,
        session_id: me.session_id,
        kind: me.kind,
        notify_path: notifyPathFor(me.handle),
        wake_adapter: {
          installed: ctx.adapterStatus.installed,
          framework: ctx.adapterStatus.framework,
          ...(ctx.adapterStatus.hint ? { hint: ctx.adapterStatus.hint } : {}),
        },
        context_used: me.context_used,
        context_total: me.context_total,
        context_reported_at: me.context_reported_at,
        // #103 — emitted beside the number so a frozen reading cannot be read
        // as a live one. Both agents treated a 28-day-old 100% as current.
        ...gaugeFreshness(me.context_reported_at, now),
        online_peers: peers.map((a) => ({
          handle: a.handle,
          display_name: a.display_name,
          kind: a.kind,
          context_used: a.context_used,
          context_total: a.context_total,
          context_reported_at: a.context_reported_at,
          ...gaugeFreshness(a.context_reported_at, now),
        })),
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    },
  );
}
