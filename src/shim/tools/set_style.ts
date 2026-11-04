import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as dao from '../../storage/dao.js';
import { assertRoomName } from '../../util/naming.js';
import type { ShimContext } from '../index.js';

export function installSetStyle(server: McpServer, ctx: ShimContext): void {
  server.registerTool(
    'set_style',
    {
      title: 'Set the conversation style for a room',
      description:
        'Set the prose style agents must follow in a room. Rooms only — a peer target is refused, because a peer style would be stored and never delivered. `succinct` is the only preset; `custom` takes your own markdown and REPLACES the preset rather than layering on it. Pass style=null to clear. The style is pushed with every room_inbox read of that room, so it arrives before the writing rather than waiting to be fetched.',
      inputSchema: {
        target: z
          .string()
          .describe('A room name with its leading # (e.g. "#gate"). A peer handle is refused.'),
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

      // Rooms only — the refusal and its reason live in the DAO, where a test
      // can reach them. See `assertStyleTarget`.
      dao.assertStyleTarget(target);

      {
        assertRoomName(target);

        if (!dao.roomExists(ctx.db, target)) {
          throw new Error(`No such room ${target}. Call room_join first.`);
        }

        dao.setRoomStyle(ctx.db, target, style, custom);
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
