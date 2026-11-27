import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, statSync } from "node:fs";
import { dbPath, ensureStateDir, STATE_FILE_MODE } from "../util/paths.js";

export type Db = DatabaseSync;

const MIGRATIONS: readonly ((db: Db) => void)[] = [
  (db) => {
    db.exec(`
      CREATE TABLE agents (
        handle        TEXT PRIMARY KEY,
        display_name  TEXT,
        pid           INTEGER,
        session_id    TEXT NOT NULL,
        registered_at INTEGER NOT NULL,
        last_seen_at  INTEGER NOT NULL,
        metadata_json TEXT
      );
      CREATE TABLE messages (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        from_handle  TEXT NOT NULL,
        to_handle    TEXT NOT NULL,
        body         TEXT NOT NULL,
        sent_at      INTEGER NOT NULL,
        delivered_at INTEGER,
        read_at      INTEGER
      );
      CREATE INDEX ix_messages_to_read ON messages(to_handle, read_at);
    `);
  },
  (db) => {
    db.exec(`
      CREATE TABLE rooms (
        name        TEXT PRIMARY KEY,
        created_at  INTEGER NOT NULL,
        created_by  TEXT NOT NULL
      );
      CREATE TABLE room_members (
        room_name   TEXT NOT NULL REFERENCES rooms(name) ON DELETE CASCADE,
        handle      TEXT NOT NULL,
        joined_at   INTEGER NOT NULL,
        PRIMARY KEY (room_name, handle)
      );
      CREATE TABLE room_reads (
        room_name     TEXT NOT NULL,
        handle        TEXT NOT NULL,
        last_read_id  INTEGER NOT NULL,
        PRIMARY KEY (room_name, handle)
      );
      CREATE INDEX ix_room_members_handle ON room_members(handle);
    `);
  },
  (db) => {
    // Message coordination metadata: 'chat' (default), 'dispatch' (task
    // hand-off), 'alert' (blocking / high-severity). Existing rows keep the
    // default via the NOT NULL DEFAULT clause.
    db.exec(`
      ALTER TABLE messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'chat';
    `);
  },
  (db) => {
    // Agent live status + freeform focus subtitle. Nullable — legacy agents
    // that never set a status render as "unknown".
    db.exec(`
      ALTER TABLE agents ADD COLUMN status TEXT;
      ALTER TABLE agents ADD COLUMN focus TEXT;
      ALTER TABLE agents ADD COLUMN status_updated_at INTEGER;
    `);
  },
  (db) => {
    // Per-agent context-window gauge (tokens_used / tokens_total, both in the
    // agent's own tokenizer). Reported by the peer via chat.report_context —
    // used by sibling agents and the human to see who's running low and
    // needs /compact or /clear. Nullable so agents that never report just
    // read back as an unknown gauge.
    db.exec(`
      ALTER TABLE agents ADD COLUMN context_used INTEGER;
      ALTER TABLE agents ADD COLUMN context_total INTEGER;
      ALTER TABLE agents ADD COLUMN context_reported_at INTEGER;
    `);
  },
  (db) => {
    // Highest context-usage threshold band this agent has been warned about
    // and hasn't yet dropped below (with 5% hysteresis). Value is one of
    // NULL / 70 / 85 / 95. Prevents re-firing the same warning every time
    // the peer reports while sitting in the same band; auto-decrements one
    // band at a time when the peer drops below (band - 5%).
    db.exec(`
      ALTER TABLE agents ADD COLUMN context_warned_threshold INTEGER;
    `);
  },
  (db) => {
    // Permission requests a supervised agent is blocked on.
    //
    // 🛑 THE SUPERVISOR AND THE WEB SERVER ARE SEPARATE PROCESSES. They
    // already share this database, so it is the channel — the supervisor
    // writes a row and nudges the notify bus, and the browser tab re-fetches
    // over the SSE stream it already has.
    //
    // `requested` is the command VERBATIM. It is what the operator approves
    // and what then goes into the allowlist, so a paraphrase would grant
    // something the child never asked for.
    db.exec(`
      CREATE TABLE approvals (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        -- The child that was refused, for the operator to read.
        agent_handle      TEXT NOT NULL,
        -- 🛑 WHO TO WAKE WITH THE ANSWER. A first cut nudged the WEB USER's
        -- own handle, which wakes nobody who can act. The guard test on
        -- bodyless wakes is what surfaced it.
        supervisor_handle TEXT NOT NULL,
        requested    TEXT NOT NULL,
        reason       TEXT NOT NULL,
        session_id   TEXT,
        created_at   INTEGER NOT NULL,
        answered_at  INTEGER,
        decision     TEXT
      );
      CREATE INDEX ix_approvals_pending ON approvals(answered_at, id);
    `);
  },
  (db) => {
    // Make `approvals.requested` NULLABLE.
    //
    // 🚨 A SEPARATE MIGRATION, NOT AN EDIT TO THE ONE ABOVE. Editing
    // migration 7 in place left `MIGRATIONS.length` at 7, so
    // `for (i = current; i < length)` ran zero times on an existing
    // database and lee's table kept NOT NULL. Measured live: an unnameable
    // denial hit the constraint, threw, and logged "nobody will be asked" —
    // the exact silence this change exists to remove.
    //
    // ⚠️ AND MIGRATION 7 IS LEFT AS IT SHIPPED, deliberately. If 7 were also
    // edited, a fresh database would arrive nullable and never run this
    // migration — so the rebuild below would execute nowhere except an
    // already-migrated machine, which is the one place nothing tests.
    // Raised by claude1.
    //
    // SQLite cannot drop NOT NULL, so the table is rebuilt.
    db.exec(`
      CREATE TABLE approvals_new (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_handle      TEXT NOT NULL,
        supervisor_handle TEXT NOT NULL,
        -- NULL when the CLI named no command. A placeholder here is what
        -- let lee approve a blank that then granted nothing.
        requested         TEXT,
        reason            TEXT NOT NULL,
        session_id        TEXT,
        created_at        INTEGER NOT NULL,
        answered_at       INTEGER,
        decision          TEXT
      );
      INSERT INTO approvals_new
        SELECT id, agent_handle, supervisor_handle, requested, reason,
               session_id, created_at, answered_at, decision
          FROM approvals;
      DROP TABLE approvals;
      ALTER TABLE approvals_new RENAME TO approvals;
      CREATE INDEX ix_approvals_pending ON approvals(answered_at, id);
    `);
  },
  (db) => {
    // The allowlist entry that grants exactly the refused invocation.
    //
    // 🛑 A SECOND COLUMN, NOT A REUSE OF `requested`. The CLI's refusal names
    // the command in PROSE — "rm in '/path/README.md'" — and
    // `--allowedTools` does not speak that. Measured live: lee approved the
    // prose, it went into the allowlist, granted nothing, and the child was
    // denied again with a second card.
    //
    // ⚠️ A SEPARATE MIGRATION because editing an earlier one never reaches a
    // database that already ran it. That mistake is migration 8's whole
    // reason for existing.
    db.exec(`
      ALTER TABLE approvals ADD COLUMN grant_entry TEXT;
    `);
  },
  (db) => {
    // Every equivalent spelling of the granted command, JSON-encoded.
    //
    // 🚨 ONE SPELLING WAS NOT ENOUGH. On macOS `/var` is a symlink to
    // `/private/var`, so a grant approved as `/var/…` did not match a retry
    // the supervisor itself had prompted as `/private/var/…`. Measured
    // live; the cause was this supervisor's own realpath resolution.
    //
    // `grant_entry` stays the one the operator SEES. This column is what is
    // actually allowlisted, and it includes that one.
    db.exec(`
      ALTER TABLE approvals ADD COLUMN grant_forms TEXT;
    `);
  },
  (db) => {
    // What the child was allowed to use when it was refused, JSON-encoded.
    //
    // 🛑 WITHOUT IT A REFUSAL CANNOT SAY WHAT A GRANT WOULD HAVE DONE. The
    // same command is refused under one allowlist and permitted under
    // another — measured on approvals 23 and 25, where only the allowlist
    // differed. A row that omits it can only ever answer "refused".
    //
    // NULL on an older row means UNRECORDED, never "nothing was allowed".
    // Every approval filed before this column had a non-empty allowlist that
    // nobody wrote down.
    db.exec(`
      ALTER TABLE approvals ADD COLUMN allowlist TEXT;
    `);
  },
  (db) => {
    // #92 — the conversation style a room or a peer expects.
    //
    // `style` holds a preset name or the literal 'custom'. `style_custom`
    // holds the markdown used when it is 'custom'. NULL style means no
    // preference, and nothing is pushed — the unset path stays byte-identical.
    //
    // ⚠️ A SEPARATE MIGRATION, per migration 8's docblock. Editing an earlier
    // one never reaches a database that already ran it.
    db.exec(`
      ALTER TABLE rooms  ADD COLUMN style TEXT;
      ALTER TABLE rooms  ADD COLUMN style_custom TEXT;
      ALTER TABLE agents ADD COLUMN style TEXT;
      ALTER TABLE agents ADD COLUMN style_custom TEXT;
    `);
  },
  (db) => {
    // #92 — the `normal` preset is gone, so rows holding it are cleared.
    //
    // 🛑 NOT A NO-OP: one room was already set to it. `resolveStyle` returns
    // undefined for an unknown preset, so the row would have pushed nothing
    // while the column still read "normal" — a style configured and silently
    // inert, which is the half-written state this feature already refuses.
    //
    // ⚠️ A SEPARATE MIGRATION, per migration 8's docblock.
    db.exec(`
      UPDATE rooms  SET style = NULL, style_custom = NULL WHERE style = 'normal';
      UPDATE agents SET style = NULL, style_custom = NULL WHERE style = 'normal';
    `);
  },
  (db) => {
    // #101 — a claim on a shared resource, as rows rather than prose.
    //
    // 🛑 A ROW PER CLAIM, NEVER A ROW PER RESOURCE. The history is the point:
    // "who held the gate when this broke" is unanswerable from a table that
    // only remembers the current holder, and that question is why #101 exists.
    //
    // 🛑 `expires_at` IS NOT NULLABLE. A claim with no expiry is the lock
    // nobody can clear, which is the failure lee's ruling names — expiry is
    // the failsafe for an agent that died holding one.
    //
    // ⚠️ A SEPARATE MIGRATION, per migration 8's docblock. Editing an earlier
    // one never reaches a database that already ran it.
    db.exec(`
      CREATE TABLE claims (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        resource    TEXT    NOT NULL,
        holder      TEXT    NOT NULL,
        note        TEXT,
        claimed_at  INTEGER NOT NULL,
        expires_at  INTEGER NOT NULL,
        released_at INTEGER
      );
      CREATE INDEX claims_by_resource ON claims (resource, id DESC);
    `);
  },
  (db) => {
    // #163 — an answered approval recorded WHAT was decided and WHEN, and
    // nothing about WHO decided it.
    //
    // 🛑 NULLABLE, AND A NULL MEANS UNKNOWN. Every row answered before this
    // column existed has one, so a default would attribute those decisions to
    // a handle nobody chose.
    //
    // ⚠️ A SEPARATE MIGRATION, per migration 8's docblock. Editing an earlier
    // one never reaches a database that already ran it.
    db.exec(`ALTER TABLE approvals ADD COLUMN answered_by TEXT`);
  },
  (db) => {
    // #224 — unread DEPTH was visible in four surfaces and nothing fired on
    // it. The bands fire on the AGE of the oldest unread instead, and need one
    // place to remember which band an agent has already been told about.
    //
    // 🛑 A SECOND COLUMN, NOT A REUSE OF `context_warned_threshold`. The two
    // axes are independent — an agent can be low on context and current on its
    // inbox — and they share no band values, so one column would let a context
    // warning silence a backlog warning.
    //
    // 🛑 NULLABLE, AND NULL MEANS "NOT WARNED". An agent that caught up is
    // written back to null so the same band can fire again on a fresh climb.
    //
    // ⚠️ A SEPARATE MIGRATION, per migration 8's docblock. Editing an earlier
    // one never reaches a database that already ran it.
    db.exec(`ALTER TABLE agents ADD COLUMN unread_warned_threshold INTEGER`);
  },
  (db) => {
    // #135 — the restart threshold a supervised agent is measured against.
    // lee ruled the shape on 2026-11-09: a global default with a per-handle
    // override, mirroring `git config --global` against a local.
    //
    // 🛑 TWO PLACES BECAUSE THE PRECEDENCE IS THE FEATURE. A single column on
    // `agents` could not express "every handle, including ones not registered
    // yet", and a single global could not express an exception.
    //
    // 🛑 `settings` IS KEY/VALUE AND DELIBERATELY UNTYPED AT THE SQL LAYER.
    // The readers validate, because a hand-edited or restored database can
    // hold a value no writer here would have accepted.
    //
    // 🛑 NULLABLE, AND NULL MEANS "NO OVERRIDE". A default of 50 on the column
    // would make every existing agent's gate indistinguishable from one lee
    // had chosen for it, so the global could never move them again.
    //
    // ⚠️ A SEPARATE MIGRATION, per migration 8's docblock. Editing an earlier
    // one never reaches a database that already ran it.
    db.exec(`
      CREATE TABLE settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    db.exec(`ALTER TABLE agents ADD COLUMN context_gate INTEGER`);
  },

  // Whether a supervised child holds the one tool a DM reply needs (#475).
  //
  // 🛑 NULLABLE, AND NULL MEANS UNKNOWN AND SENDABLE. The supervisor is the
  // only writer and it can crash, so a non-null default would turn debris
  // into a permanent refusal for a handle that can answer perfectly well.
  //
  // ⚠️ A SEPARATE MIGRATION, per migration 8's docblock. Editing an earlier
  // one never reaches a database that already ran it.
  (db) => {
    db.exec(`ALTER TABLE agents ADD COLUMN can_reply INTEGER`);
  },
];

/**
 * The version a fully migrated database reports.
 *
 * 🛑 DERIVED, NEVER TYPED. A test used to pin the literal `13`, so every new
 * migration had to edit a test named for conversation styles — a second copy
 * of a number that only moves one way.
 *
 * ⚠️ It is NOT a substitute for the version pin. Comparing a database to this
 * only proves every migration registered its own version, which is migration
 * 8's bug. A test still has to assert the floor, so deleting a migration is
 * loud.
 */
export const SCHEMA_VERSION = MIGRATIONS.length;

/**
 * A content fingerprint per migration, in version order.
 *
 * 🛑 THIS IS THE ONLY THING THAT FAILS WHEN A MIGRATION IS EDITED IN PLACE.
 * `migrate` starts at the version a database already stores, so an edit to an
 * earlier entry never runs there and no behavioural test can reach it. The
 * pinned list in `migration-content.test.ts` is what turns that into a
 * failure.
 *
 * ⚠️ IT HASHES THE TRANSPILED BODY, which has two measured consequences. A
 * `//` comment outside the SQL does NOT move a fingerprint. A `--` comment
 * INSIDE the template literal DOES, because that text is part of what ran on
 * every existing database. A bundler upgrade that reflows output moves all of
 * them at once, which is loud rather than silent.
 */
export function migrationFingerprints(): readonly string[] {
  return MIGRATIONS.map((m) =>
    createHash("sha256").update(String(m)).digest("hex").slice(0, 16),
  );
}

/**
 * Run `fn` as one transaction, rolling back on a throw.
 *
 * ⚠️ `IMMEDIATE` TAKES THE WRITE LOCK AT `BEGIN`. A plain `BEGIN` is deferred,
 * so a writer only contends on its first statement and can then fail part-way
 * with `SQLITE_BUSY` — which is the partial state a transaction is here to
 * prevent. Writers pass `IMMEDIATE`; `migrate` holds the database alone.
 *
 * 🛑 NESTING THROWS. `node:sqlite` exposes no `isTransaction`, so this cannot
 * detect an outer transaction and SQLite refuses the inner `BEGIN`.
 */
export function tx(
  db: Db,
  fn: () => void,
  mode: "DEFERRED" | "IMMEDIATE" = "DEFERRED",
): void {
  db.exec(mode === "IMMEDIATE" ? "BEGIN IMMEDIATE" : "BEGIN");
  try {
    fn();
    db.exec("COMMIT");
  } catch (e) {
    // 🛑 THE CAUSE WINS OVER THE CLEANUP. A severe failure rolls the
    // transaction back itself, so this `ROLLBACK` then throws "no transaction
    // is active" — an error naming nothing about what failed. Nothing is
    // swallowed: `e` is rethrown either way.
    try {
      db.exec("ROLLBACK");
    } catch {
      /* the rethrow below carries the real cause */
    }

    throw e;
  }
}

/**
 * The schema version this database reports, or null before any migration ran.
 *
 * Lives here because `db.ts` owns the table — it creates it in `migrate()`.
 */
export function currentSchemaVersion(db: Db): number | null {
  const row = db
    .prepare("SELECT MAX(version) AS v FROM schema_version")
    .get() as unknown as { v: number | null };
  return row.v ?? null;
}

/** Create the version table, then apply everything between `current` and `target`. */
function applyMigrations(db: Db, target: number): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)`,
  );
  const current = currentSchemaVersion(db) ?? 0;
  for (let i = current; i < target; i++) {
    const version = i + 1;
    const migration = MIGRATIONS[i];
    if (!migration) throw new Error(`Missing migration ${version}`);
    tx(db, () => {
      migration(db);
      db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(
        version,
      );
    });
  }
}

/**
 * Migrate only as far as `target`, so a test can build a database at an
 * earlier version and then watch `migrate` carry it forward.
 *
 * ⚠️ IT IS A SEAM, NOT A GUARD. It lets a test be written against migration
 * N on a database at N-1. It cannot make an in-place EDIT of an earlier
 * migration fail anything, because the loop still starts at the stored
 * version. The pin in `migration-content.test.ts` is what catches that.
 *
 * 🛑 IT REFUSES RATHER THAN CLAMPS. `Math.min` answered `migrateTo(db, 999)`
 * with a CURRENT database and no complaint, which is the vacuous fixture this
 * seam exists to remove.
 */
export function migrateTo(db: Db, target: number): void {
  if (!Number.isInteger(target) || target < 1 || target > MIGRATIONS.length) {
    throw new Error(
      `migrateTo: target ${target} is not a version. Pass 1..${MIGRATIONS.length} (SCHEMA_VERSION).`,
    );
  }

  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)`,
  );
  const current = currentSchemaVersion(db) ?? 0;

  // A migration cannot be undone, so a lower target is a caller mistake.
  // `migrate` does NOT share this message — a database above SCHEMA_VERSION
  // means the BUILD is stale, which is a different cause and a different fix.
  if (current > target) {
    throw new Error(
      `migrateTo: database is already at version ${current}, cannot go back to ${target}.`,
    );
  }

  applyMigrations(db, target);
}

/**
 * Bring a database up to this build's schema. Called by `openDb` on every
 * process start, so it has to be idempotent.
 *
 * 🛑 IT REFUSES A DATABASE NEWER THAN ITSELF. An older build does not know
 * what a newer migration moved, and until #191 lands both agents open one
 * `chat.db` from separate worktrees, so proceeding would write to a schema
 * this code has never seen.
 */
export function migrate(db: Db): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)`,
  );
  const current = currentSchemaVersion(db) ?? 0;

  if (current > MIGRATIONS.length) {
    throw new Error(
      `This build is older than this database: it knows ${MIGRATIONS.length} migrations, the database is at version ${current}. Pull and rebuild.`,
    );
  }

  applyMigrations(db, MIGRATIONS.length);
}

/**
 * The second connection a write is read back on, per primary handle.
 *
 * 🛑 THE WRITING CONNECTION IS NOT A WITNESS. #138's shim held a view of this
 * file nobody else had, so re-reading through it would have confirmed its own
 * wrong answer for the whole outage. lee ruled for a separate connection.
 */
const verifiers = new WeakMap<Db, Db>();

/** The device and inode of the file a connection actually opened. */
export type FileIdentity = { readonly dev: number; readonly ino: number };

/**
 * What each connection's file WAS, so a swap underneath it becomes visible.
 *
 * 🛑 A PATH IS NOT AN IDENTITY. `lsof` and `PRAGMA database_list` both report
 * the path a connection was opened on, so neither can tell a replaced file at
 * that path from the original. Recording the inode at open is what gives
 * `health` a mark that can disagree with the path.
 */
const identities = new WeakMap<Db, FileIdentity>();

/** Undefined only for a database that did not come from `openDb`. */
export function identityFor(db: Db): FileIdentity | undefined {
  return identities.get(db);
}

/**
 * The identity of whatever is at `path` now, or null when nothing is.
 *
 * 🛑 ONLY "NOTHING IS THERE" IS A DIAGNOSIS. ENOENT is the file being gone and
 * ENOTDIR is a parent component that stopped being a directory, which is the
 * same fault reached one level up — both mean there is no database file at this
 * path, as firmly as each other.
 *
 * ⚠️ EACCES AND ELOOP ARE RETHROWN ON PURPOSE. A permission change and a
 * symlink cycle are faults of their own, and reporting either as "the file no
 * longer exists" would be a confident false statement about a chmod mistake.
 */
export function identityOf(path: string): FileIdentity | null {
  try {
    const found = statSync(path);
    return { dev: found.dev, ino: found.ino };
  } catch (err) {
    const { code } = err as NodeJS.ErrnoException;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw err;
  }
}

/** Undefined only for a database that did not come from `openDb` — see `insertMessage`. */
export function verifierFor(db: Db): Db | undefined {
  return verifiers.get(db);
}

/**
 * True when this connection no longer holds the file at `dbPath()`.
 *
 * 🛑 THE ONE COPY OF THE COMPARISON. It lived inside `insertMessage`, which
 * is why `messages` was the only table a swap could not silently eat: 23 other
 * writers in `dao.ts` reached `.run()` with no mark check at all. A second copy
 * is how the 24th drifts, so new writers call `assertLiveDatabase` and a guard
 * test asserts every one of them does.
 *
 * ⚠️ AN UNSET MARK IS NOT A MISMATCH. `openDb` throws rather than handing
 * back an unmarked connection, so this is reached only by a database that did
 * not come from it — in practice `:memory:`, which has no file to compare.
 * That also means this predicate is a NO-OP under most tests, so presence at a
 * call site is not proof the mechanism works. One real-file swap test is.
 */
export function databaseWasReplaced(db: Db): boolean {
  const atOpen = identityFor(db);
  if (!atOpen) return false;

  const now = identityOf(dbPath());

  return !now || now.dev !== atOpen.dev || now.ino !== atOpen.ino;
}

/**
 * A write was refused because nothing written through this connection can be
 * read by anyone else.
 *
 * 🛑 NOT RETRYABLE ON THIS HANDLE, AND THE MESSAGE HAS TO SAY SO. The
 * replacement is a property of the CONNECTION, so every retry lands in the same
 * orphaned file. `MessageNotPersistedError` carries the same sentence for sends,
 * which have a from and a to to name; this one is for the writers that do not.
 */
export class DatabaseReplacedError extends Error {
  constructor(readonly operation: string) {
    super(
      `${operation} was refused. This connection holds a database file that is ` +
        `no longer the file at ${dbPath()}, so nothing written through it can ` +
        `be read by anyone else. RESTART this agent; retrying on this handle ` +
        `writes to the same orphaned file.`,
    );
    this.name = "DatabaseReplacedError";
  }
}

/**
 * Refuse a write whose connection holds a replaced file.
 *
 * 🛑 CALL IT AS A WRITER'S FIRST LINE, BEFORE ANY STATEMENT. Checking
 * mid-operation is what would turn a replaced file into PARTIAL state —
 * `joinRoom` writes `room_members` before it announces, so a throw between them
 * leaves a member joined with no announcement. Checked first, a refused writer
 * has written nothing.
 */
export function assertLiveDatabase(db: Db, operation: string): void {
  if (databaseWasReplaced(db)) throw new DatabaseReplacedError(operation);
}

export function openDb(): Db {
  ensureStateDir();
  const db = new DatabaseSync(dbPath());

  // 🛑 BEFORE THE VERIFIER OPEN AND BEFORE `migrate`, both of which re-resolve
  // this path. Statting later would record the REPLACEMENT file's identity on a
  // swap mid-startup, so `health` would compare a mark to itself and report OK
  // for a connection writing to the file that was moved away.
  const opened = identityOf(dbPath());

  // 🛑 A CONNECTION WITHOUT A MARK CAN NEVER SELF-CHECK, SO IT MUST NOT EXIST.
  // `insertMessage` compares this mark on every send and SKIPS the comparison
  // when it is absent, which made a missing mark a silent licence to write into
  // a replaced file for the life of the process. Throwing here is what makes
  // "came from `openDb`" and "carries a mark" the same statement.
  //
  // ⚠️ REACHED ONLY BY AN UNLINK INSIDE THIS WINDOW. `new DatabaseSync(path)`
  // creates the file eagerly — measured — so the file is there one line above.
  // Something removing it between these two lines is the state directory being
  // destroyed under a live process, which is lee's "fail loudly" case, not a
  // condition to paper over.
  if (!opened) {
    throw new Error(
      `The database at ${dbPath()} vanished while it was being opened, so ` +
        `this connection cannot tell whether its file is later replaced. ` +
        `Something is modifying the state directory; retry once it is stable.`,
    );
  }

  identities.set(db, opened);

  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);

  // Opened eagerly, so an unusable database fails here rather than on the first
  // send. One file handle per process; a send pays nothing for it.
  const verifier = new DatabaseSync(dbPath());
  verifier.exec("PRAGMA journal_mode = WAL");
  verifiers.set(db, verifier);

  // 🛑 `close()` HAS TO CLOSE BOTH. A second live connection keeps the WAL on
  // disk past a clean close, and the WAL is the file holding the newest
  // traffic — which is what `tightenDbFiles` below exists to protect.
  const closePrimary = db.close.bind(db);
  db.close = () => {
    try {
      verifier.close();
    } catch {
      // Already closed. A teardown that throws leaves the PRIMARY open, which
      // is the handle that matters; `closePrimary` still reports its own errors.
    } finally {
      closePrimary();
    }
  };

  tightenDbFiles();

  return db;
}

/**
 * 🛑 THE WAL IS THE FILE WORTH READING. It holds the newest messages, SQLite
 * creates it itself at the umask mode, and no caller ever names it. A 0600
 * database beside a 0644 WAL discloses the traffic that matters most.
 *
 * Not durable on its own: SQLite may re-create the WAL at the umask mode
 * after a checkpoint. The 0700 state directory is what actually holds.
 */
function tightenDbFiles(): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    const path = `${dbPath()}${suffix}`;
    if (existsSync(path)) chmodSync(path, STATE_FILE_MODE);
  }
}
