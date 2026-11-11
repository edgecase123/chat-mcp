import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as dao from '../../storage/dao.js';
import type { BusHealth } from '../../storage/dao.js';
import { SCHEMA_VERSION } from '../../storage/db.js';
import { dbPath } from '../../util/paths.js';
import type { ShimContext } from '../index.js';

/**
 * What the two marks mean, in a sentence.
 *
 * 🛑 EVERY BRANCH IS A CLAIM ABOUT WHAT HAPPENED, so each one is tested. The
 * four states are genuinely different: the marks AGREEING means no INSERT was
 * ever attempted, which is #138, while `max_id` below the mark means a row
 * was written and removed. One number cannot tell those apart.
 */
export function healthReading(health: BusHealth): string {
  const { max_id, autoincrement_seq } = health;

  if (max_id === null) return 'No message has ever been written to this database.';

  if (autoincrement_seq === null) {
    return `The table holds ids up to ${max_id}, but sqlite_sequence carries no row for it, so the high-water mark is unreadable. A restore that dropped sqlite_sequence does this.`;
  }

  if (max_id === autoincrement_seq) {
    return `The table is intact at id ${max_id}. A send claiming a HIGHER id than this did not persist.`;
  }

  if (max_id < autoincrement_seq) {
    return `MAX(id) ${max_id} is below the high-water mark ${autoincrement_seq}, so rows were written and are now gone.`;
  }

  return `MAX(id) ${max_id} is ABOVE the high-water mark ${autoincrement_seq}, so sqlite_sequence was reset or lost rather than rows going missing.`;
}

export function installHealth(server: McpServer, ctx: ShimContext): void {
  server.registerTool(
    'health',
    {
      title: 'Is the bus actually writing?',
      description:
        "Report the database this shim resolved and the two id marks that say whether a reported message id is real: MAX(id) and the AUTOINCREMENT high-water mark. Call it when a send claimed an id you cannot find, when a peer's reply never arrives, or before concluding a sibling never answered — a send that reports success while nothing persists is a known failure (#138), and this is the check that catches it without shelling out to sqlite3.",
      inputSchema: {},
    },
    // 🛑 NO try/catch. An unreadable database must surface as a tool error,
    // not as a reading with nulls in it. lee, on #138: fail loudly.
    async () => {
      const health = dao.busHealth(ctx.db);
      const schemaMatches = health.schema_version === SCHEMA_VERSION;

      const result = {
        handle: ctx.handle,
        db_path: dbPath(),
        ...health,
        schema_version_expected: SCHEMA_VERSION,
        schema_matches: schemaMatches,
        reading: healthReading(health),
        ...(schemaMatches
          ? {}
          : {
              warning: `This database is at schema ${health.schema_version} but this build expects ${SCHEMA_VERSION}. Another version migrated it.`,
            }),
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    },
  );
}
