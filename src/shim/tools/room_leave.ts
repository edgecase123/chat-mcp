import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as dao from '../../storage/dao.js';
import { assertRoomName } from '../../util/naming.js';
import type { ShimContext } from '../index.js';

export function installRoomLeave(server: McpServer, ctx: ShimContext): void {
  server.registerTool(
    'room_leave',
    {
      title: 'Leave a room',
      description:
        'Leave a room. Idempotent — no error if you were never a member. The room persists as long as any member remains; empty rooms remain in the roster until manually cleaned up.',
      inputSchema: {
        room: z.string().describe('Room name including leading # (e.g. "#gate")'),
      },
    },
    async ({ room }) => {
      assertRoomName(room);
      dao.touchLastSeen(ctx.db, ctx.handle);
      const removed = dao.leaveRoom(ctx.db, room, ctx.handle);
      return {
        content: [{ type: 'text', text: JSON.stringify({ room, removed }) }],
      };
    },
  );
}
