import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as dao from '../../storage/dao.js';
import type { ShimContext } from '../index.js';

export function registerWhoami(server: McpServer, ctx: ShimContext): void {
  server.registerTool(
    'whoami',
    {
      title: 'Who am I on the chat bus?',
      description:
        'Return this shim\'s handle, session_id, and kind, plus the current list of online peers on the chat bus. Cheap self-discovery — call this after your MCP client starts to confirm you\'re registered and see who else is available to chat with.',
      inputSchema: {},
    },
    async () => {
      dao.touchLastSeen(ctx.db, ctx.handle);
      const me = dao.getAgent(ctx.db, ctx.handle);
      if (!me) throw new Error(`Agent row missing for handle=${ctx.handle}`);
      const peers = dao.listAgents(ctx.db, false).filter((a) => a.handle !== ctx.handle);
      const result = {
        handle: me.handle,
        display_name: me.display_name,
        session_id: me.session_id,
        kind: me.kind,
        online_peers: peers.map((a) => ({
          handle: a.handle,
          display_name: a.display_name,
          kind: a.kind,
        })),
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    },
  );
}
