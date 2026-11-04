import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as dao from '../../storage/dao.js';
import { decideClaim, decideRelease, remainingMs, ttlMinutes } from '../../claims/lifecycle.js';
import type { Db } from '../../storage/db.js';
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

const CONFLICT_HINT = 'Ask the holder in the room, or `release` with force if you know their process is gone.';

/**
 * Decide and store one claim, as the payload the tool returns.
 *
 * 🛑 SPLIT OUT OF THE TOOL SO THE LOST RACE IS REACHABLE BY A TEST. The branch
 * that matters is the compare-and-swap refusing, and a `null` nobody checks is
 * the original bug with extra steps.
 */
export function performClaim(input: {
  db: Db;
  holder: string;
  resource: string;
  note: string | null;
  now: number;
  ttlMinutes: number;
}): Record<string, unknown> {
  const { db, holder, resource, note, now } = input;
  const existing = dao.latestClaim(db, resource);
  const decision = decideClaim({ existing, resource, holder, now, ttlMinutes: input.ttlMinutes });

  if (decision.outcome === 'conflict') {
    return {
      outcome: 'conflict',
      resource,
      held_by: decision.heldBy,
      expires_in_minutes: minutes(decision.remainingMs ?? 0),
      hint: CONFLICT_HINT,
    };
  }

  // 🛑 A RENEWAL UPDATES THE SAME ROW. Appending would lose `claimed_at`,
  // which is the answer to "how long has this been held".
  const row =
    decision.outcome === 'renewed' && existing !== null
      ? dao.renewClaim(db, { id: existing.id, holder, expires_at: decision.expires_at as number, now })
      : dao.insertClaim(db, {
          resource,
          holder,
          note,
          claimed_at: now,
          expires_at: decision.expires_at as number,
        });

  // 🛑 THE SWAP REFUSED, SO A RIVAL LANDED IN THE WINDOW. The decision was
  // judged against a row that has since moved, so re-read rather than
  // reporting a grant nobody holds.
  if (row === null) {
    const rival = dao.latestClaim(db, resource);

    return {
      outcome: 'conflict',
      resource,
      held_by: rival?.holder,
      expires_in_minutes: minutes(rival === null ? 0 : remainingMs(rival, now)),
      hint: CONFLICT_HINT,
      lost_race: true,
    };
  }

  return {
    outcome: decision.outcome,
    resource,
    holder,
    expires_in_minutes: minutes(remainingMs(row, now)),
    // Surfaced because the failsafe firing means somebody never released.
    took_over_from: decision.tookOverFrom,
  };
}

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

      return text(
        performClaim({
          db: ctx.db,
          holder: ctx.handle,
          resource: name,
          note: note && note.length > 0 ? note : null,
          now: Date.now(),
          ttlMinutes: ttlMinutes(),
        }),
      );
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
