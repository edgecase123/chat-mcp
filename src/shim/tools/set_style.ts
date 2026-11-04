import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as dao from '../../storage/dao.js';
import { assertRoomName } from '../../util/naming.js';
import type { ShimContext } from '../index.js';

export function installSetStyle(server: McpServer, ctx: ShimContext): void {
  server.registerTool(
    'set_style',
    {
      title: 'Set the conversation style for a room or a peer',
      description:
        'Set the prose style agents must follow in a room, or when writing to one peer. `succinct` is the only preset; `custom` takes your own markdown and REPLACES the preset rather than layering on it. Pass style=null to clear. The style is pushed with every room_inbox read of that room, so it arrives before the writing rather than waiting to be fetched.',
      inputSchema: {
        target: z
          .string()
          .describe('A room name with its leading # (e.g. "#gate"), or a peer handle (e.g. "claude2").'),
        style: z
          .enum(['succinct', 'custom'])
          .nullable()
          .describe('"succinct", "custom", or null to clear any style.'),
        custom: z
          .string()
          .optional()
          .describe('Markdown, required when style is "custom". Capped at 64 KB, the message body cap.'),
      },
    },
    async ({ target, style, custom }) => {
      dao.touchLastSeen(ctx.db, ctx.handle);

      if (style !== null) {
        dao.assertStyleName(style);
        dao.assertStyleCustom(style, custom);
      }

      // 🛑 A ROOM OR A HANDLE, decided by the `#`, the same discriminator every
      // other tool here uses. Writing a style to a target that does not exist
      // would UPDATE zero rows and report success, so both branches check.
      if (target.startsWith('#')) {
        assertRoomName(target);

        if (!dao.roomExists(ctx.db, target)) {
          throw new Error(`No such room ${target}. Call room_join first.`);
        }

        dao.setRoomStyle(ctx.db, target, style, custom);
      } else {
        if (dao.getAgent(ctx.db, target) === null) {
          throw new Error(`No such peer "${target}". Call list_agents to see who is registered.`);
        }

        dao.setAgentStyle(ctx.db, target, style, custom);
      }

      return {
        content: [
          {
            type: 'text',
            text:
              style === null
                ? `Cleared the conversation style for ${target}.`
                : `Conversation style for ${target} is now "${style}".`,
          },
        ],
      };
    },
  );
}
