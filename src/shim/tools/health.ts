import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as dao from '../../storage/dao.js';
import type { BusHealth } from '../../storage/dao.js';
import { identityFor, identityOf, SCHEMA_VERSION } from '../../storage/db.js';
import type { FileIdentity } from '../../storage/db.js';
import { dbPath } from '../../util/paths.js';
import type { ShimContext } from '../index.js';

/**
 * What the two marks mean, in a sentence.
 *
 * 🛑 EVERY BRANCH IS A CLAIM ABOUT WHAT HAPPENED, so each one is tested. One
 * number cannot tell "no INSERT was ever attempted" apart from "rows were
 * written and removed" — an empty table with a live high-water mark is the
 * second, not the first.
 */
export function healthReading(health: BusHealth): string {
  const { max_id, autoincrement_seq } = health;

  if (max_id === null) {
    if (autoincrement_seq === null) return 'No message has ever been written to this database.';
    return `The table is EMPTY, but the high-water mark is ${autoincrement_seq}, so ids up to there were written and every row is now gone. Deleting a room's or a DM's messages does this.`;
  }

  if (autoincrement_seq === null) {
    return `The table holds ids up to ${max_id}, but sqlite_sequence carries no row for it, so the high-water mark is unreadable. A restore that dropped sqlite_sequence does this.`;
  }

  if (max_id === autoincrement_seq) {
    return `The TOP of the table is intact at id ${max_id}. A send claiming a HIGHER id than this did not persist. These two marks say nothing about holes below ${max_id}.`;
  }

  if (max_id < autoincrement_seq) {
    return `MAX(id) ${max_id} is below the high-water mark ${autoincrement_seq}, so rows were written and are now gone.`;
  }

  return `MAX(id) ${max_id} is ABOVE the high-water mark ${autoincrement_seq}, so sqlite_sequence was reset or lost rather than rows going missing.`;
}

/**
 * Whether the file this connection holds is still the file at this path.
 *
 * 🛑 THE TWO ID MARKS CANNOT SEE #138, BECAUSE THE WRITE SUCCEEDED. Nothing
 * was locked out and the ids were sequential, which is what a commit to a
 * store nobody else was reading looks like. Device plus inode is the mark that
 * can disagree with the path, so each branch here is a claim and is tested.
 */
export function identityReading(
  atOpen: FileIdentity | undefined | null,
  now: FileIdentity | undefined | null,
): { matches: boolean; reading: string } {
  if (!atOpen) {
    return {
      matches: false,
      // Not a match and not a fault. Claiming either would be an instrument
      // that could not say no.
      reading:
        'This connection did not record a file identity at open, so whether the file moved underneath it is UNREADABLE. Only a database opened through openDb carries the mark.',
    };
  }

  const at = `device ${atOpen.dev} inode ${atOpen.ino}`;

  if (!now) {
    return {
      matches: false,
      reading: `The database file at this path NO LONGER EXISTS. This connection is still writing to the deleted file it opened (${at}), where no other process can read it.`,
    };
  }

  if (atOpen.dev === now.dev && atOpen.ino === now.ino) {
    return {
      matches: true,
      reading: `The file this connection holds IS the file at this path (${at}).`,
    };
  }

  return {
    matches: false,
    reading: `This connection opened ${at}, but this path NOW resolves to device ${now.dev} inode ${now.ino}. The file was replaced underneath the connection, so every write since lands in a file no other process can read — while the path, and every tool that reports one, stays identical. This is #138.`,
  };
}

/** Everything `health` reports. `warnings` is absent, never empty, when all is well. */
export type HealthResult = BusHealth & {
  handle: string;
  db_path: string;
  schema_version_expected: number;
  schema_matches: boolean;
  db_identity_at_open: FileIdentity | null;
  db_identity_now: FileIdentity | null;
  db_identity_matches: boolean;
  reading: string;
  identity_reading: string;
  warnings?: string[];
};

/** Everything `health` reports, assembled from marks the caller has already taken. */
export function healthResult(args: {
  handle: string;
  db_path: string;
  health: BusHealth;
  atOpen: FileIdentity | undefined;
  now: FileIdentity | null;
}): HealthResult {
  const { handle, db_path, health, atOpen, now } = args;
  const schemaMatches = health.schema_version === SCHEMA_VERSION;
  const identity = identityReading(atOpen, now);

  // 🛑 ONE ARRAY, NOT A KEY PER SOURCE. A caller that reads `warning` and finds
  // a schema mismatch there stops looking, so a second concurrent fault would
  // be invisible. Both faults are reportable at once and both arrive here.
  const warnings = [
    schemaMatches
      ? null
      : `This database is at schema ${health.schema_version} but this build expects ${SCHEMA_VERSION}. Another version migrated it.`,
    identity.matches ? null : identity.reading,
  ].filter((w): w is string => w !== null);

  return {
    handle,
    db_path,
    ...health,
    schema_version_expected: SCHEMA_VERSION,
    schema_matches: schemaMatches,
    db_identity_at_open: atOpen ?? null,
    db_identity_now: now,
    db_identity_matches: identity.matches,
    reading: healthReading(health),
    identity_reading: identity.reading,
    // Omitted rather than empty, so the key's PRESENCE is the signal.
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

export function installHealth(server: McpServer, ctx: ShimContext): void {
  server.registerTool(
    'health',
    {
      title: 'Is the bus actually writing, and to the right file?',
      description:
        "Report the database this shim resolved, the two id marks that say whether a reported message id is real (MAX(id) and the AUTOINCREMENT high-water mark), and whether the file this connection holds is still the file at that path. Call it when a send claimed an id you cannot find, when a peer's reply never arrives, or before concluding a sibling never answered. A send that reports success while the peer sees nothing is a known failure (#138) and has two shapes: the write never landed, which the id marks catch, or it landed in a replaced file at the same path, which only the device+inode comparison catches — lsof and PRAGMA database_list both report a path and cannot see it.",
      inputSchema: {},
    },
    // 🛑 NO try/catch. An unreadable database must surface as a tool error,
    // not as a reading with nulls in it. lee, on #138: fail loudly.
    async () => {
      // 🛑 RESOLVED ONCE. Reporting `db_path` from one resolution while
      // statting another would let the two disagree, which is the exact class
      // of fault this tool exists to catch.
      const path = dbPath();

      const result = healthResult({
        handle: ctx.handle,
        db_path: path,
        health: dao.busHealth(ctx.db),
        atOpen: identityFor(ctx.db),
        now: identityOf(path),
      });

      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    },
  );
}
