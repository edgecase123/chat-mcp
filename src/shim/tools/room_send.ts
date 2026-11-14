import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as dao from '../../storage/dao.js';
import { MAX_BODY_BYTES, NotARoomMemberError, sendToRoom } from '../../messaging/room-send.js';
import type { ShimContext } from '../index.js';

export function installRoomSend(server: McpServer, ctx: ShimContext): void {
  server.registerTool(
    'room_send',
    {
      title: 'Post a message to a room',
      description:
        'Post a message to a room you are a member of. Every current member (except you) gets a notify event; offline members see the message on their next room_inbox call. Returns `notified`, how many members were written to, and `online_members`, how many of those the bus believes are live right now — `online_members: 0` means nobody is there to read it yet. Body cap 64 KB.',
      inputSchema: {
        room: z.string().describe('Room name including leading # (e.g. "#gate")'),
        body: z.string().describe('Message body (UTF-8, max 64 KB)'),
        kind: z
          .enum(['chat', 'dispatch', 'alert'])
          .optional()
          .describe('Coordination kind. "chat" (default), "dispatch" (task hand-off), or "alert" (blocking / high-severity — surfaces in every member\'s alert lane).'),
      },
    },
    async ({ room, body, kind }) => {
      dao.touchLastSeen(ctx.db, ctx.handle);

      let result;
      try {
        // advanceOwnRead: false — an agent's own post must stay out of its
        // `room_inbox`, which `roomUnread` already handles by author.
        result = sendToRoom(ctx.db, {
          from: ctx.handle, room, body, kind, advanceOwnRead: false,
        });
      } catch (e) {
        if (e instanceof NotARoomMemberError) {
          throw new Error(`Not a member of ${room}. Call room_join first.`);
        }
        throw e;
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              message_id: result.id,
              sent_at: result.sent_at,
              room,
              notified: result.notified,
              // 🛑 BOTH, AND `notified` FIRST BECAUSE IT IS THE OLDER NAME. A
              // caller that reads only `notified` gets the member count, which
              // is what it has always meant. `online_members` is the one that
              // answers "is anyone there to read this".
              online_members: result.onlineMembers,
            }),
          },
        ],
      };
    },
  );
}
