import { DatabaseSync } from 'node:sqlite';
import { dbPath, ensureStateDir } from '../util/paths.js';

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
        -- 🛑 NULLABLE. A denial does not always NAME its command: a
        -- git-push refusal gives a prose reason with no command in it.
        -- NOT NULL forced a placeholder, lee approved a blank, and the
        -- placeholder went into --allowedTools and granted nothing.
        requested    TEXT,
        reason       TEXT NOT NULL,
        session_id   TEXT,
        created_at   INTEGER NOT NULL,
        answered_at  INTEGER,
        decision     TEXT
      );
      CREATE INDEX ix_approvals_pending ON approvals(answered_at, id);
    `);
  },
];

function tx(db: Db, fn: () => void): void {
  db.exec('BEGIN');
  try {
    fn();
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function migrate(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)`);
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as unknown as { v: number | null };
  const current = row.v ?? 0;
  for (let i = current; i < MIGRATIONS.length; i++) {
    const version = i + 1;
    const migration = MIGRATIONS[i];
    if (!migration) throw new Error(`Missing migration ${version}`);
    tx(db, () => {
      migration(db);
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(version);
    });
  }
}

export function openDb(): Db {
  ensureStateDir();
  const db = new DatabaseSync(dbPath());
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}
