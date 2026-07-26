import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as dao from '../../storage/dao.js';
import { notifyPathFor } from '../../util/paths.js';
import type { ShimContext } from '../index.js';

export function installRegister(server: McpServer, ctx: ShimContext): void {
  server.registerTool(
    'register',
    {
      title: 'Update your profile on the chat bus',
      description:
        "Update this peer's display_name and/or metadata. Idempotent — the shim already auto-registered on boot with kind=agent. Rarely called directly; prefer whoami for self-discovery.",
      inputSchema: {
        display_name: z.string().optional().describe('Human-friendly name for this peer'),
        metadata: z
          .any()
          .optional()
          .describe('Arbitrary key/value metadata; kind defaults to "agent" if omitted'),
      },
    },
    async ({ display_name, metadata }) => {
      const merged: Record<string, unknown> = { ...(metadata as Record<string, unknown> ?? {}) };
      if (typeof merged.kind !== 'string') merged.kind = 'agent';
      dao.upsertAgent(ctx.db, {
        handle: ctx.handle,
        pid: process.pid,
        session_id: ctx.session_id,
        display_name: display_name ?? ctx.handle,
        metadata: merged,
      });
      const me = dao.getAgent(ctx.db, ctx.handle);
      if (!me) throw new Error(`Agent row missing after upsert for handle=${ctx.handle}`);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              handle: me.handle,
              session_id: me.session_id,
              notify_path: notifyPathFor(me.handle),
            }),
          },
        ],
      };
    },
  );
}
