import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as dao from '../../storage/dao.js';
import { notifyPeer } from '../../notify/bus.js';
import { assertRoomName } from '../../util/naming.js';
import type { ShimContext } from '../index.js';

export function installRoomJoin(server: McpServer, ctx: ShimContext): void {
  server.registerTool(
    'room_join',
    {
      title: 'Join a room',
      description:
        'Join a named room (auto-created on first join). Room names must start with # (e.g. "#gate"). Idempotent — safe to call if already a member. Only current members see messages sent to a room; pre-join history is not surfaced. On a first-time join (not on idempotent re-join), a system message ("<handle> joined <room>", from="system") is posted to the room so existing members see the announcement.',
      inputSchema: {
        room: z.string().describe('Room name including leading # (e.g. "#gate")'),
      },
    },
    async ({ room }) => {
      assertRoomName(room);
      dao.touchLastSeen(ctx.db, ctx.handle);
      const result = dao.joinRoom(ctx.db, room, ctx.handle);

      if (result.was_new_member && result.system_message) {
        const members = dao.roomMembers(ctx.db, room);
        for (const member of members) {
          if (member === ctx.handle) continue;
          notifyPeer(member, {
            id: result.system_message.id,
            to: room,
            from: dao.SYSTEM_HANDLE,
            ts: result.system_message.sent_at,
          });
        }
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(result.room) }],
      };
    },
  );
}
