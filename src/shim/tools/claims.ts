import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as dao from '../../storage/dao.js';
import { decideClaim, decideRelease, remainingMs, ttlMinutes } from '../../claims/lifecycle.js';
import type { ShimContext } from '../index.js';

/**
 * #101 — a claim on a shared resource, as a row the UI can show.
 *
 * 🛑 THREE TOOLS IN ONE FILE, against the one-tool-per-file convention. They
 * share the resource-name rule and the shape of their replies, and splitting
 * them would make that one rule three copies. Named here so the next reader
 * does not "fix" it.
 *
 * 🛑 NONE OF THEM DECIDE ANYTHING. Every rule lives in
 * `src/claims/lifecycle.ts`, pure and unit-tested. A lock that is wrong is
 * silent, so the logic must be reachable without two agents colliding.
 */

const MAX_RESOURCE_LEN = 120;
const MAX_NOTE_LEN = 200;

/** Minutes, rounded, for a human-readable refusal. */
const minutes = (ms: number) => Math.max(1, Math.round(ms / 60_000));

const text = (payload: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
});

export function installClaims(server: McpServer, ctx: ShimContext): void {
  server.registerTool(
    'claim',
    {
      title: 'Claim a shared resource',
      description:
        'Take an exclusive claim on a shared resource — the gate script, a Docker stack, a branch, a file two agents could both touch. Refuses if someone else already holds it and tells you who. Re-claiming something you already hold renews it. Claims expire on a generous failsafe, but you are expected to call `release` when you are done.',
      inputSchema: {
        resource: z
          .string()
          .min(1)
          .max(MAX_RESOURCE_LEN)
          .describe('What you are claiming. Use the same spelling every time — "reset-and-test.sh", "leagues_app".'),
        note: z
          .string()
          .max(MAX_NOTE_LEN)
          .optional()
          .describe('Optional one line on why, shown beside the claim.'),
      },
    },
    async ({ resource, note }) => {
      const name = resource.trim();
      if (name.length === 0) return text({ outcome: 'invalid', reason: 'resource is blank' });

      const now = Date.now();
      const existing = dao.latestClaim(ctx.db, name);
      const decision = decideClaim({
        existing,
        resource: name,
        holder: ctx.handle,
        now,
        ttlMinutes: ttlMinutes(),
      });

      if (decision.outcome === 'conflict') {
        return text({
          outcome: 'conflict',
          resource: name,
          held_by: decision.heldBy,
          expires_in_minutes: minutes(decision.remainingMs ?? 0),
          hint: 'Ask the holder in the room, or `release` with force if you know their process is gone.',
        });
      }

      // 🛑 A RENEWAL UPDATES THE SAME ROW. Appending would lose `claimed_at`,
      // which is the answer to "how long has this been held".
      const row =
        decision.outcome === 'renewed' && existing !== null
          ? dao.renewClaim(ctx.db, existing.id, decision.expires_at as number)
          : dao.insertClaim(ctx.db, {
              resource: name,
              holder: ctx.handle,
              note: note && note.length > 0 ? note : null,
              claimed_at: now,
              expires_at: decision.expires_at as number,
            });

      return text({
        outcome: decision.outcome,
        resource: name,
        holder: ctx.handle,
        expires_in_minutes: minutes(remainingMs(row, now)),
        // Surfaced because the failsafe firing means somebody never released.
        took_over_from: decision.tookOverFrom,
      });
    },
  );

  server.registerTool(
    'release',
    {
      title: 'Release a claim',
      description:
        'Give up a claim you hold. The onus is on you to call this when you are done — expiry is only a failsafe. Pass force to clear a claim held by an agent you know is gone.',
      inputSchema: {
        resource: z.string().min(1).max(MAX_RESOURCE_LEN).describe('The resource you claimed.'),
        force: z
          .boolean()
          .optional()
          .describe("Release someone else's claim. Only when you know their process is gone."),
      },
    },
    async ({ resource, force }) => {
      const name = resource.trim();
      const now = Date.now();
      const existing = dao.latestClaim(ctx.db, name);
      const decision = decideRelease({ existing, by: ctx.handle, force: force === true, now });

      if (decision.outcome === 'not-held') {
        return text({ outcome: 'not-held', resource: name, hint: 'Nothing live to release. Check the spelling.' });
      }

      if (decision.outcome === 'not-yours') {
        return text({
          outcome: 'not-yours',
          resource: name,
          held_by: decision.heldBy,
          hint: 'Pass force only if you know that process is gone.',
        });
      }

      dao.releaseClaim(ctx.db, existing?.id as number, now);

      return text({
        outcome: 'released',
        resource: name,
        forced_from: decision.forcedFrom,
      });
    },
  );

  server.registerTool(
    'claims',
    {
      title: 'List live claims',
      description:
        'Every resource currently claimed, with its holder, how long it has been held and how long until the failsafe frees it. Call this before starting anything a sibling agent could already be holding.',
      inputSchema: {},
    },
    async () => {
      const now = Date.now();

      return text({
        claims: dao.liveClaims(ctx.db, now).map((c) => ({
          resource: c.resource,
          holder: c.holder,
          note: c.note,
          held_for_minutes: minutes(now - c.claimed_at),
          expires_in_minutes: minutes(remainingMs(c, now)),
        })),
      });
    },
  );
}
