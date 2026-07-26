import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as dao from '../../storage/dao.js';
import { assertRoomName } from '../../util/naming.js';
import type { ShimContext } from '../index.js';

export function installRoomJoin(server: McpServer, ctx: ShimContext): void {
  server.registerTool(
    'room_join',
    {
      title: 'Join a room',
      description:
        'Join a named room (auto-created on first join). Room names must start with # (e.g. "#gate"). Idempotent — safe to call if already a member. Only current members see messages sent to a room; pre-join history is not surfaced.',
      inputSchema: {
        room: z.string().describe('Room name including leading # (e.g. "#gate")'),
      },
    },
    async ({ room }) => {
      assertRoomName(room);
      dao.touchLastSeen(ctx.db, ctx.handle);
      const r = dao.joinRoom(ctx.db, room, ctx.handle);
      return {
        content: [{ type: 'text', text: JSON.stringify(r) }],
      };
    },
  );
}
