import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as dao from '../../storage/dao.js';
import type { ShimContext } from '../index.js';
import { toWireMessage } from '../tools/inbox.js';

export function installInboxResource(server: McpServer, ctx: ShimContext): void {
  const uri = `chat-inbox://${ctx.handle}`;

  server.registerResource(
    'chat-inbox',
    uri,
    {
      title: `Inbox for ${ctx.handle}`,
      description: `Unread messages addressed to ${ctx.handle}. Server sends notifications/resources/updated when new mail arrives — MCP clients that surface these to the model provide ambient awareness of incoming messages without polling.`,
      mimeType: 'application/json',
    },
    async (readUri) => {
      const messages = dao.pendingInbox(ctx.db, { to: ctx.handle });
      const payload = messages.map(toWireMessage);
      return {
        contents: [
          {
            uri: readUri.href,
            mimeType: 'application/json',
            text: JSON.stringify(payload, null, 2),
          },
        ],
      };
    },
  );

  ctx.notify.subscribe(() => {
    const pending = dao.pendingInbox(ctx.db, { to: ctx.handle });
    if (pending.length === 0) return;
    dao.markDelivered(ctx.db, pending.map((m) => m.id));
    void server.server.sendResourceUpdated({ uri }).catch(() => {
      // Client may have disconnected; the shim will exit via transport.onclose.
    });
  });
}
