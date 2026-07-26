import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as dao from '../../storage/dao.js';
import type { ShimContext } from '../index.js';

export function installRoomList(server: McpServer, ctx: ShimContext): void {
  server.registerTool(
    'room_list',
    {
      title: 'List rooms',
      description:
        'List rooms you are a member of. Pass include_all=true to see every room known to the bus (useful for discovery before room_join).',
      inputSchema: {
        include_all: z
          .boolean()
          .optional()
          .describe('Include rooms you are not a member of'),
      },
    },
    async ({ include_all }) => {
      dao.touchLastSeen(ctx.db, ctx.handle);
      const rooms = include_all
        ? dao.allRooms(ctx.db)
        : dao.myRooms(ctx.db, ctx.handle);
      return {
        content: [{ type: 'text', text: JSON.stringify(rooms, null, 2) }],
      };
    },
  );
}
