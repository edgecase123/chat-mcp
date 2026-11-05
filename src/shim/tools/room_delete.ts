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

      // 🛑 THE MEMBERSHIP CHECK USED TO LIVE HERE AND IS NOW IN
      // `dao.deleteRoom`, with the owner-only rule beside it. This is the path
      // agents actually delete through, and the first cut of #89 gated only the
      // web route — so this tool kept enforcing the old rule.
      const result = dao.deleteRoom(ctx.db, room, ctx.handle);

      if (!result.ok) {
        if (result.reason === 'not-a-member') {
          throw new Error(
            `Cannot delete ${room}: caller is not a member. Join first to confirm the room exists, or ask a current member to delete.`,
          );
        }
        if (result.reason === 'owner-only') {
          throw new Error(
            `Cannot delete ${room}: only ${result.owner} created it and is still a member. Ask them, or wait until they leave.`,
          );
        }
        // `not-found`. Reported as a value, not thrown: the old tool answered
        // `{ deleted: false }` here and a caller may be relying on that.
        return {
          content: [{ type: 'text', text: JSON.stringify({ room, deleted: false }) }],
        };
      }

      return {
        content: [{ type: 'text', text: JSON.stringify({ room, deleted: true }) }],
      };
    },
  );
}
