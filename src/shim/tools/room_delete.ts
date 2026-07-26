import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as dao from '../../storage/dao.js';
import { assertRoomName } from '../../util/naming.js';
import type { ShimContext } from '../index.js';

export function installRoomDelete(server: McpServer, ctx: ShimContext): void {
  server.registerTool(
    'room_delete',
    {
      title: 'Delete a room',
      description:
        'Delete a room entirely, cascading membership, read watermarks, and any messages sent to the room. Caller must be a current member. No announcement is sent (nobody is left to read it).',
      inputSchema: {
        room: z.string().describe('Room name including leading # (e.g. "#gate")'),
      },
    },
    async ({ room }) => {
      assertRoomName(room);
      dao.touchLastSeen(ctx.db, ctx.handle);

      if (!dao.isRoomMember(ctx.db, room, ctx.handle)) {
        throw new Error(
          `Cannot delete ${room}: caller is not a member. Join first to confirm the room exists, or ask a current member to delete.`,
        );
      }

      const deleted = dao.deleteRoom(ctx.db, room);
      return {
        content: [{ type: 'text', text: JSON.stringify({ room, deleted }) }],
      };
    },
  );
}
