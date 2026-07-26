import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as dao from '../../storage/dao.js';
import { notifyPeer } from '../../notify/bus.js';
import { assertRoomName } from '../../util/naming.js';
import type { ShimContext } from '../index.js';

const MAX_BODY_BYTES = 64 * 1024;

export function installRoomSend(server: McpServer, ctx: ShimContext): void {
  server.registerTool(
    'room_send',
    {
      title: 'Post a message to a room',
      description:
        'Post a message to a room you are a member of. Every current member (except you) gets a notify event; offline members see the message on their next room_inbox call. Body cap 64 KB.',
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
      assertRoomName(room);
      if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
        throw new Error(`Message body exceeds ${MAX_BODY_BYTES}-byte cap`);
      }
      if (!dao.isRoomMember(ctx.db, room, ctx.handle)) {
        throw new Error(`Not a member of ${room}. Call room_join first.`);
      }
      dao.touchLastSeen(ctx.db, ctx.handle);
      const result = dao.insertMessage(ctx.db, { from: ctx.handle, to: room, body, kind });

      // Notify all currently-online members except sender. Offline members
      // pick it up via room_inbox when they come online.
      const members = dao.roomMembers(ctx.db, room);
      for (const member of members) {
        if (member === ctx.handle) continue;
        notifyPeer(member, { id: result.id, to: room, from: ctx.handle, ts: result.sent_at });
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              message_id: result.id,
              sent_at: result.sent_at,
              room,
              notified: members.length - 1,
            }),
          },
        ],
      };
    },
  );
}
