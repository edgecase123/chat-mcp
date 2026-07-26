import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as dao from '../../storage/dao.js';
import { notifyPeer } from '../../notify/bus.js';
import { assertRoomName } from '../../util/naming.js';
import type { ShimContext } from '../index.js';

export function installRoomBoot(server: McpServer, ctx: ShimContext): void {
  server.registerTool(
    'room_boot',
    {
      title: 'Boot a participant from a room',
      description:
        'Remove a specific handle from a room. Caller must be a current member and cannot boot themselves (use room_leave). Posts a system message "<caller> booted <handle> from <room>" so remaining members see the event.',
      inputSchema: {
        room: z.string().describe('Room name including leading # (e.g. "#gate")'),
        handle: z.string().describe('Handle to boot from the room'),
      },
    },
    async ({ room, handle }) => {
      assertRoomName(room);
      dao.touchLastSeen(ctx.db, ctx.handle);

      if (!dao.isRoomMember(ctx.db, room, ctx.handle)) {
        throw new Error(
          `Cannot boot from ${room}: caller is not a member.`,
        );
      }
      if (handle === ctx.handle) {
        throw new Error('Cannot boot yourself — use room_leave instead.');
      }
      if (!dao.isRoomMember(ctx.db, room, handle)) {
        throw new Error(`${handle} is not a member of ${room}.`);
      }

      const removed = dao.bootFromRoom(ctx.db, room, handle);

      const now = Date.now();
      const body = `${ctx.handle} booted ${handle} from ${room}`;
      const sysInfo = ctx.db.prepare(
        `INSERT INTO messages (from_handle, to_handle, body, sent_at) VALUES (?, ?, ?, ?)`,
      ).run(dao.SYSTEM_HANDLE, room, body, now);
      const sysId = Number(sysInfo.lastInsertRowid);

      const remaining = dao.roomMembers(ctx.db, room);
      for (const member of remaining) {
        if (member === ctx.handle) continue;
        notifyPeer(member, {
          id: sysId,
          to: room,
          from: dao.SYSTEM_HANDLE,
          ts: now,
        });
      }

      return {
        content: [{ type: 'text', text: JSON.stringify({ room, handle, removed }) }],
      };
    },
  );
}
