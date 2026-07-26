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

// ─────────────────────────────────────────────────────────────
// Rooms (migration 2)
// ─────────────────────────────────────────────────────────────

export interface Room {
  name: string;
  created_at: number;
  created_by: string;
  member_count: number;
}

interface RoomRow {
  name: string;
  created_at: number;
  created_by: string;
}

/**
 * Join a room, creating it if it doesn't exist. Idempotent — if the caller
 * is already a member, returns the existing room + no-op. First joiner
 * becomes the created_by. Initializes room_reads to the current max message
 * id so pre-join history stays hidden.
 */
export function joinRoom(db: Db, room: string, handle: string): Room {
  const now = Date.now();
  db.prepare(
    `INSERT INTO rooms (name, created_at, created_by) VALUES (?, ?, ?)
     ON CONFLICT(name) DO NOTHING`,
  ).run(room, now, handle);

  const existing = db.prepare(
    `SELECT joined_at FROM room_members WHERE room_name = ? AND handle = ?`,
  ).get(room, handle) as { joined_at: number } | undefined;

  if (!existing) {
    db.prepare(
      `INSERT INTO room_members (room_name, handle, joined_at) VALUES (?, ?, ?)`,
    ).run(room, handle, now);

    // Anchor unread watermark at current max id so we don't see history
    // sent before we joined.
    const maxRow = db.prepare(
      `SELECT COALESCE(MAX(id), 0) AS max_id FROM messages WHERE to_handle = ?`,
    ).get(room) as { max_id: number };
    db.prepare(
      `INSERT INTO room_reads (room_name, handle, last_read_id) VALUES (?, ?, ?)
       ON CONFLICT(room_name, handle) DO UPDATE SET last_read_id = excluded.last_read_id`,
    ).run(room, handle, maxRow.max_id);
  }

  return hydrateRoom(db, room);
}

export function leaveRoom(db: Db, room: string, handle: string): boolean {
  const info = db.prepare(
    `DELETE FROM room_members WHERE room_name = ? AND handle = ?`,
  ).run(room, handle);
  // Drop the read watermark too — a subsequent rejoin will re-anchor at
  // whatever the current max_id is at that time.
  db.prepare(
    `DELETE FROM room_reads WHERE room_name = ? AND handle = ?`,
  ).run(room, handle);
  return info.changes > 0;
}

export function isRoomMember(db: Db, room: string, handle: string): boolean {
  const row = db.prepare(
    `SELECT 1 AS x FROM room_members WHERE room_name = ? AND handle = ?`,
  ).get(room, handle) as { x: number } | undefined;
  return row !== undefined;
}

/** Members of a room, in join order. Includes offline members. */
export function roomMembers(db: Db, room: string): string[] {
  const rows = db.prepare(
    `SELECT handle FROM room_members WHERE room_name = ? ORDER BY joined_at ASC`,
  ).all(room) as { handle: string }[];
  return rows.map((r) => r.handle);
}

/** Rooms the caller is a member of. */
export function myRooms(db: Db, handle: string): Room[] {
  const rows = db.prepare(
    `SELECT r.name, r.created_at, r.created_by
     FROM rooms r
     JOIN room_members m ON m.room_name = r.name
     WHERE m.handle = ?
     ORDER BY r.name ASC`,
  ).all(handle) as RoomRow[];
  return rows.map((r) => hydrateRoomFromRow(db, r));
}

/** All rooms known to the bus (for /rooms --all). */
export function allRooms(db: Db): Room[] {
  const rows = db.prepare(
    `SELECT name, created_at, created_by FROM rooms ORDER BY name ASC`,
  ).all() as RoomRow[];
  return rows.map((r) => hydrateRoomFromRow(db, r));
}

function hydrateRoom(db: Db, name: string): Room {
  const row = db.prepare(
    `SELECT name, created_at, created_by FROM rooms WHERE name = ?`,
  ).get(name) as RoomRow | undefined;
  if (!row) throw new Error(`Room ${name} does not exist`);
  return hydrateRoomFromRow(db, row);
}

function hydrateRoomFromRow(db: Db, row: RoomRow): Room {
  const count = db.prepare(
    `SELECT COUNT(*) AS n FROM room_members WHERE room_name = ?`,
  ).get(row.name) as { n: number };
  return {
    name: row.name,
    created_at: row.created_at,
    created_by: row.created_by,
    member_count: count.n,
  };
}

/**
 * Unread messages for a (room, handle) pair. Uses the per-member watermark
 * so each member reads independently. Does NOT advance the watermark —
 * call `advanceRoomRead` after presenting the messages.
 */
export function roomUnread(
  db: Db,
  room: string,
  handle: string,
  limit = 50,
): Message[] {
  const read = db.prepare(
    `SELECT last_read_id FROM room_reads WHERE room_name = ? AND handle = ?`,
  ).get(room, handle) as { last_read_id: number } | undefined;
  const since = read?.last_read_id ?? 0;
  const rows = db.prepare(
    `SELECT * FROM messages
     WHERE to_handle = ? AND id > ?
     ORDER BY id ASC
     LIMIT ?`,
  ).all(room, since, Math.min(Math.max(limit, 1), 500)) as MessageRow[];
  return rows.map(toMessage);
}

export function advanceRoomRead(
  db: Db,
  room: string,
  handle: string,
  upToId: number,
): void {
  db.prepare(
    `INSERT INTO room_reads (room_name, handle, last_read_id) VALUES (?, ?, ?)
     ON CONFLICT(room_name, handle) DO UPDATE SET
       last_read_id = MAX(room_reads.last_read_id, excluded.last_read_id)`,
  ).run(room, handle, upToId);
}

/**
 * Unread across every room the caller is a member of. Used by an
 * unfiltered `chat.room_inbox` call.
 */
export function allRoomsUnread(db: Db, handle: string, limit = 50): Message[] {
  const rooms = myRooms(db, handle);
  const cap = Math.min(Math.max(limit, 1), 500);
  const collected: Message[] = [];
  for (const r of rooms) {
    if (collected.length >= cap) break;
    const remaining = cap - collected.length;
    const batch = roomUnread(db, r.name, handle, remaining);
    collected.push(...batch);
  }
  // Interleaved by id ascending so the caller sees chronological order.
  return collected.sort((a, b) => a.id - b.id);
}
