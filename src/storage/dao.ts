import type { Database as Db } from 'better-sqlite3';

export interface Agent {
  handle: string;
  display_name: string | null;
  pid: number | null;
  session_id: string;
  registered_at: number;
  last_seen_at: number;
  metadata: Record<string, unknown>;
  kind: string;
  online: boolean;
}

export interface Message {
  id: number;
  from_handle: string;
  to_handle: string;
  body: string;
  sent_at: number;
  delivered_at: number | null;
  read_at: number | null;
}

interface AgentRow {
  handle: string;
  display_name: string | null;
  pid: number | null;
  session_id: string;
  registered_at: number;
  last_seen_at: number;
  metadata_json: string | null;
}

interface MessageRow {
  id: number;
  from_handle: string;
  to_handle: string;
  body: string;
  sent_at: number;
  delivered_at: number | null;
  read_at: number | null;
}

function isAlive(pid: number | null): boolean {
  if (pid == null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException;
    return err.code === 'EPERM';
  }
}

function hydrate(row: AgentRow): Agent {
  const metadata = row.metadata_json ? (JSON.parse(row.metadata_json) as Record<string, unknown>) : {};
  const kind = typeof metadata.kind === 'string' ? metadata.kind : 'agent';
  return {
    handle: row.handle,
    display_name: row.display_name,
    pid: row.pid,
    session_id: row.session_id,
    registered_at: row.registered_at,
    last_seen_at: row.last_seen_at,
    metadata,
    kind,
    online: isAlive(row.pid),
  };
}

export interface RegisterInput {
  handle: string;
  display_name?: string | null;
  pid: number;
  session_id: string;
  metadata?: Record<string, unknown>;
}

export function upsertAgent(db: Db, input: RegisterInput): Agent {
  const now = Date.now();
  const metadata_json = input.metadata ? JSON.stringify(input.metadata) : null;
  db.prepare(
    `INSERT INTO agents (handle, display_name, pid, session_id, registered_at, last_seen_at, metadata_json)
     VALUES (@handle, @display_name, @pid, @session_id, @now, @now, @metadata_json)
     ON CONFLICT(handle) DO UPDATE SET
       display_name  = excluded.display_name,
       pid           = excluded.pid,
       session_id    = excluded.session_id,
       last_seen_at  = excluded.last_seen_at,
       metadata_json = excluded.metadata_json`,
  ).run({
    handle: input.handle,
    display_name: input.display_name ?? null,
    pid: input.pid,
    session_id: input.session_id,
    now,
    metadata_json,
  });
  const agent = getAgent(db, input.handle);
  if (!agent) throw new Error(`Failed to register agent ${input.handle}`);
  return agent;
}

export function getAgent(db: Db, handle: string): Agent | null {
  const row = db.prepare(`SELECT * FROM agents WHERE handle = ?`).get(handle) as AgentRow | undefined;
  return row ? hydrate(row) : null;
}

export function listAgents(db: Db, includeOffline = false): Agent[] {
  const rows = db.prepare(`SELECT * FROM agents ORDER BY last_seen_at DESC`).all() as AgentRow[];
  const agents = rows.map(hydrate);
  return includeOffline ? agents : agents.filter((a) => a.online);
}

export function touchLastSeen(db: Db, handle: string): void {
  db.prepare(`UPDATE agents SET last_seen_at = ? WHERE handle = ?`).run(Date.now(), handle);
}

export interface SendInput {
  from: string;
  to: string;
  body: string;
}

export interface SendResult {
  id: number;
  sent_at: number;
}

export function insertMessage(db: Db, input: SendInput): SendResult {
  const sent_at = Date.now();
  const info = db.prepare(
    `INSERT INTO messages (from_handle, to_handle, body, sent_at) VALUES (?, ?, ?, ?)`,
  ).run(input.from, input.to, input.body, sent_at);
  return { id: Number(info.lastInsertRowid), sent_at };
}

export interface InboxQuery {
  to: string;
  sinceId?: number;
  limit?: number;
}

export function pendingInbox(db: Db, query: InboxQuery): Message[] {
  const since = query.sinceId ?? 0;
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 500);
  const rows = db.prepare(
    `SELECT * FROM messages
     WHERE to_handle = ? AND read_at IS NULL AND id > ?
     ORDER BY id ASC
     LIMIT ?`,
  ).all(query.to, since, limit) as MessageRow[];
  return rows.map(toMessage);
}

export function markRead(db: Db, ids: number[]): void {
  if (ids.length === 0) return;
  const now = Date.now();
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`UPDATE messages SET read_at = ? WHERE id IN (${placeholders}) AND read_at IS NULL`).run(
    now,
    ...ids,
  );
}

export function markDelivered(db: Db, ids: number[]): void {
  if (ids.length === 0) return;
  const now = Date.now();
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`UPDATE messages SET delivered_at = ? WHERE id IN (${placeholders}) AND delivered_at IS NULL`).run(
    now,
    ...ids,
  );
}

export function undeliveredFor(db: Db, handle: string): Message[] {
  const rows = db.prepare(
    `SELECT * FROM messages WHERE to_handle = ? AND delivered_at IS NULL ORDER BY id ASC`,
  ).all(handle) as MessageRow[];
  return rows.map(toMessage);
}

function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    from_handle: row.from_handle,
    to_handle: row.to_handle,
    body: row.body,
    sent_at: row.sent_at,
    delivered_at: row.delivered_at,
    read_at: row.read_at,
  };
}
