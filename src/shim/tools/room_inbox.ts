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
        'Return unread room messages and advance the read watermark. Pass a specific room to scope, or omit to read across every room you are a member of. Uses a per-member "last read id" watermark — each member reads independently, no read receipts. Pass since_id to fetch only what follows a known id, for example to recover one message whose wake payload arrived truncated; such a read leaves the skipped messages unread.',
      inputSchema: {
        room: z
          .string()
          .optional()
          .describe('Specific room (with # prefix). Omit to read across all your rooms.'),
        limit: z.number().int().min(1).max(500).optional().describe('Max messages (default 50)'),
        since_id: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            'Return only messages with an id greater than this (exclusive), same as inbox. REQUIRES room — ids are global but watermarks are per room. Raises the floor above the watermark but never below it. A since_id above the watermark skips messages, so the watermark is NOT advanced and nothing is marked read.',
          ),
      },
    },
    async ({ room, limit, since_id }) => {
      dao.assertRoomInboxQuery(room, since_id);
      dao.touchLastSeen(ctx.db, ctx.handle);

      let messages;
      if (room !== undefined) {
        assertRoomName(room);
        if (!dao.isRoomMember(ctx.db, room, ctx.handle)) {
          throw new Error(`Not a member of ${room}. Call room_join first.`);
        }
        messages = dao.roomUnread(ctx.db, room, ctx.handle, limit ?? 50, since_id);
      } else {
        messages = dao.allRoomsUnread(ctx.db, ctx.handle, limit ?? 50);
      }

      // Advance watermark(s) — group by room, since each has its own.
      //
      // 🛑 `safeRoomAdvanceId` REFUSES TO ADVANCE OVER A GAP. A since_id above
      // the watermark means messages were skipped, and advancing to the newest
      // id returned would mark those read without ever showing them.
      const idsByRoom = new Map<string, number[]>();
      for (const m of messages) {
        const list = idsByRoom.get(m.to_handle);
        if (list) list.push(m.id);
        else idsByRoom.set(m.to_handle, [m.id]);
      }
      for (const [r, ids] of idsByRoom) {
        const upTo = dao.safeRoomAdvanceId(ctx.db, r, ctx.handle, since_id, ids);
        if (upTo !== undefined) dao.advanceRoomRead(ctx.db, r, ctx.handle, upTo);
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
                kind: m.kind,
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
