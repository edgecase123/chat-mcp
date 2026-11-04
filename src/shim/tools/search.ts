import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as dao from '../../storage/dao.js';
import { parseSearch, snippet, MAX_LIMIT } from '../../search/query.js';
import type { ShimContext } from '../index.js';

/**
 * #102 — find something said earlier, without re-reading a room.
 *
 * 🛑 THIS IS THE HALF WITH THE WATERMARK HAZARD, AND IT AVOIDS IT BY NOT
 * GOING THROUGH `room_inbox`. That tool advances a per-member read pointer, so
 * a search built on it would silently mark messages read — which is precisely
 * what makes re-reading a room expensive today. `dao.searchMessages` reads
 * `messages` and writes nothing, pinned by `search-no-watermark.test.ts`.
 *
 * 🛑 THE SNIPPET IS A WINDOW AND SAYS SO. Returning whole bodies would put the
 * thing this tool exists to save — context — straight back into the caller.
 */

const SNIPPET_WIDTH = 220;

export function installSearch(server: McpServer, ctx: ShimContext): void {
  server.registerTool(
    'search',
    {
      title: 'Search the transcript',
      description:
        'Find messages containing a term, newest first, across every room and DM you can see. Does NOT mark anything read and does not touch your unread watermark, so it is safe to call mid-task. Scope it with `target` ("#gate", "claude1"). Returns a snippet around each match plus the message id.',
      inputSchema: {
        q: z.string().min(1).describe('Literal text to find. Case-insensitive. % and _ are matched literally.'),
        target: z
          .string()
          .optional()
          .describe('Limit to one room ("#gate") or one peer. Omit to search everything.'),
        limit: z
          .number()
          .int()
          .positive()
          .max(MAX_LIMIT)
          .optional()
          .describe(`Maximum results, default 50, capped at ${MAX_LIMIT}.`),
      },
    },
    async ({ q, target, limit }) => {
      const parsed = parseSearch({ q, target, limit });

      if (!parsed.ok) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: parsed.reason }) }] };
      }

      const hits = dao.searchMessages(ctx.db, {
        pattern: parsed.pattern,
        target: parsed.target,
        limit: parsed.limit,
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              // ⚠️ BOTH NUMBERS. A bare list of 50 cannot be told from a list
              // that was truncated at 50, and the caller then reasons about a
              // count that was really a cap.
              returned: hits.length,
              limit: parsed.limit,
              truncated: hits.length === parsed.limit,
              broad: parsed.broad,
              results: hits.map((h) => ({
                id: h.id,
                from: h.from_handle,
                to: h.to_handle,
                sent_at: h.sent_at,
                snippet: snippet(h.body, parsed.q, SNIPPET_WIDTH),
              })),
            }),
          },
        ],
      };
    },
  );
}
