import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as dao from "../../storage/dao.js";
import { announceToRoom } from "../../messaging/room-announce.js";
import { assertRoomName } from "../../util/naming.js";
import type { ShimContext } from "../index.js";

export function installRoomBoot(server: McpServer, ctx: ShimContext): void {
  server.registerTool(
    "room_boot",
    {
      title: "Boot a participant from a room",
      description:
        'Remove a specific handle from a room. Caller must be a current member and cannot boot themselves (use room_leave). Posts a system message "<caller> booted <handle> from <room>" so remaining members see the event.',
      inputSchema: {
        room: z
          .string()
          .describe('Room name including leading # (e.g. "#gate")'),
        handle: z.string().describe("Handle to boot from the room"),
      },
    },
    async ({ room, handle }) => {
      assertRoomName(room);
      dao.touchLastSeen(ctx.db, ctx.handle);

      if (!dao.isRoomMember(ctx.db, room, ctx.handle)) {
        throw new Error(`Cannot boot from ${room}: caller is not a member.`);
      }
      if (handle === ctx.handle) {
        throw new Error("Cannot boot yourself — use room_leave instead.");
      }
      if (!dao.isRoomMember(ctx.db, room, handle)) {
        throw new Error(`${handle} is not a member of ${room}.`);
      }

      const removed = dao.bootFromRoom(ctx.db, room, handle);

      const body = `${ctx.handle} booted ${handle} from ${room}`;

      // 🛑 ONE WRITER. The raw insert this replaced skipped every guard in
      // `insertMessage` and fanned out a `lastInsertRowid` that a swallowed
      // insert takes from another table. #138.
      announceToRoom(ctx.db, {
        room,
        body,
        actor: ctx.handle,
        // ⚠️ PRESERVED FROM THE CODE THIS REPLACED, NOT CHOSEN. The caller IS a
        // room member, and the announcement's `from_handle` is `SYSTEM_HANDLE`,
        // so `roomUnread`'s "not from me" filter does not hide it. The booting
        // agent gets its own boot back as unread. Advancing instead is a
        // behaviour change that wants its own test, so this keeps the answer
        // the three copied surfaces already gave. Raised by claude1 on #267.
        advanceActorRead: false,
      });

      return {
        content: [
          { type: "text", text: JSON.stringify({ room, handle, removed }) },
        ],
      };
    },
  );
}
