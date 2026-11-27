import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as dao from "../../storage/dao.js";
import { notifyPeer } from "../../notify/bus.js";
import type { ShimContext } from "../index.js";
import {
  noReplyRefusal,
  roomTargetRefusal,
  unknownPeerRefusal,
} from "../../util/naming.js";
import { childHandleFor } from "../../supervise/grant.js";
import { tickBacklogSafely } from "../backlog-check.js";

const MAX_BODY_BYTES = 64 * 1024;

export function installSend(server: McpServer, ctx: ShimContext): void {
  server.registerTool(
    "send",
    {
      title: "Send a 1:1 message to a peer",
      description:
        "Send a message to another peer on the chat bus. body is UTF-8 text, max 64 KB. The recipient must be a known peer (call list_agents first if unsure). A room is NOT a peer — use room_send for a #room target.",
      inputSchema: {
        to: z
          .string()
          .describe(
            "Handle of the recipient peer (never a #room — see room_send)",
          ),
        body: z.string().describe("Message body (UTF-8, max 64 KB)"),
        kind: z
          .enum(["chat", "dispatch", "alert"])
          .optional()
          .describe(
            'Coordination kind. "chat" (default) is a normal message. "dispatch" tags this as a task hand-off. "alert" tags it as blocking/high-severity and surfaces it in the recipient CLI\'s alert lane.',
          ),
      },
    },
    async ({ to, body, kind }) => {
      if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
        throw new Error(`Message body exceeds ${MAX_BODY_BYTES}-byte cap`);
      }
      if (to === ctx.handle) {
        throw new Error("Cannot send to self");
      }
      const recipient = dao.getAgent(ctx.db, to);
      if (!recipient) {
        if (to.startsWith("#")) {
          throw new Error(
            roomTargetRefusal(
              to,
              `Use room_send with room: "${to}", and room_join first if you are not a member.`,
            ),
          );
        }
        const child = childHandleFor(to);
        throw new Error(
          unknownPeerRefusal(
            to,
            dao.getAgent(ctx.db, child) ? child : null,
            "Call list_agents to see who is registered.",
          ),
        );
      }
      if (recipient.can_reply === 0) {
        throw new Error(
          noReplyRefusal(
            to,
            `Post in a room it has joined, or ask its operator to restart it with a reply tool.`,
          ),
        );
      }
      dao.touchLastSeen(ctx.db, ctx.handle);
      const result = dao.insertMessage(ctx.db, {
        from: ctx.handle,
        to,
        body,
        kind,
      });
      const unread = dao.totalUnreadFor(ctx.db, to);
      notifyPeer(to, {
        id: result.id,
        to,
        from: ctx.handle,
        ts: result.sent_at,
        body,
        kind,
        unread,
      });

      // 🛑 THE AGENT'S OWN SEND IS THE LIVENESS TICK FOR ITS OWN BACKLOG, and
      // #224 has no other event to hang one on. A sender is demonstrably
      // alive, so a message it has left unread is being ignored. Below the
      // insert, so a refused send is not a liveness signal it earned.
      tickBacklogSafely(ctx.db, ctx.handle, Date.now());

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              message_id: result.id,
              sent_at: result.sent_at,
            }),
          },
        ],
      };
    },
  );
}
