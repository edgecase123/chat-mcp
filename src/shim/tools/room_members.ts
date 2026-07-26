import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as dao from '../../storage/dao.js';
import type { ShimContext } from '../index.js';

export function installRoomMembers(server: McpServer, ctx: ShimContext): void {
  server.registerTool(
    'room_members',
    {
      title: 'List members of a room',
      description:
        'Return the handles that are current members of the given room, in join order. Includes offline members. Returns [] for an unknown or empty room. Anyone can query any room — membership counts are already surfaced by room_list.',
      inputSchema: {
        room: z
          .string()
          .describe('Room name including leading # (e.g. "#gate")'),
      },
    },
    async ({ room }) => {
      dao.touchLastSeen(ctx.db, ctx.handle);
      const members = dao.roomMembers(ctx.db, room);
      return {
        content: [{ type: 'text', text: JSON.stringify(members, null, 2) }],
      };
    },
  );
}
