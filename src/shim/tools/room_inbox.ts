import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as dao from '../../storage/dao.js';
import { assertRoomName } from '../../util/naming.js';
import type { ShimContext } from '../index.js';

export function installRoomInbox(server: McpServer, ctx: ShimContext): void {
  server.registerTool(
    'room_inbox',
    {
      title: 'Read unread room messages',
      description:
        'Return unread room messages and advance the read watermark. Pass a specific room to scope, or omit to read across every room you are a member of. Uses a per-member "last read id" watermark — each member reads independently, no read receipts.',
      inputSchema: {
        room: z
          .string()
          .optional()
          .describe('Specific room (with # prefix). Omit to read across all your rooms.'),
        limit: z.number().int().min(1).max(500).optional().describe('Max messages (default 50)'),
      },
    },
    async ({ room, limit }) => {
      dao.touchLastSeen(ctx.db, ctx.handle);

      let messages;
      if (room !== undefined) {
        assertRoomName(room);
        if (!dao.isRoomMember(ctx.db, room, ctx.handle)) {
          throw new Error(`Not a member of ${room}. Call room_join first.`);
        }
        messages = dao.roomUnread(ctx.db, room, ctx.handle, limit ?? 50);
      } else {
        messages = dao.allRoomsUnread(ctx.db, ctx.handle, limit ?? 50);
      }

      // Advance watermark(s) — group by room, advance to max id in each.
      const maxByRoom = new Map<string, number>();
      for (const m of messages) {
        const cur = maxByRoom.get(m.to_handle) ?? 0;
        if (m.id > cur) maxByRoom.set(m.to_handle, m.id);
      }
      for (const [r, maxId] of maxByRoom) {
        dao.advanceRoomRead(ctx.db, r, ctx.handle, maxId);
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              messages.map((m) => ({
                id: m.id,
                room: m.to_handle,
                from: m.from_handle,
                body: m.body,
                sent_at: m.sent_at,
              })),
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}
