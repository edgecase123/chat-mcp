import type { Db } from './db.js';

export type AgentStatus = 'idle' | 'thinking' | 'tool' | 'blocked' | 'error' | 'offline';
export type MessageKind = 'chat' | 'dispatch' | 'alert';

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
  status: AgentStatus | null;
  focus: string | null;
  status_updated_at: number | null;
}

export interface Message {
  id: number;
  from_handle: string;
  to_handle: string;
  body: string;
  sent_at: number;
  delivered_at: number | null;
  read_at: number | null;
  kind: MessageKind;
}

interface AgentRow {
  handle: string;
  display_name: string | null;
  pid: number | null;
  session_id: string;
  registered_at: number;
  last_seen_at: number;
  metadata_json: string | null;
  status: string | null;
  focus: string | null;
  status_updated_at: number | null;
}

interface MessageRow {
  id: number;
  from_handle: string;
  to_handle: string;
  body: string;
  sent_at: number;
  delivered_at: number | null;
  read_at: number | null;
  kind: string;
}

function coerceStatus(raw: string | null): AgentStatus | null {
  if (!raw) return null;
  const allowed: AgentStatus[] = ['idle', 'thinking', 'tool', 'blocked', 'error', 'offline'];
  return (allowed as string[]).includes(raw) ? (raw as AgentStatus) : null;
}

function coerceKind(raw: string | null): MessageKind {
  if (raw === 'dispatch' || raw === 'alert') return raw;
  return 'chat';
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
    status: coerceStatus(row.status),
    focus: row.focus,
    status_updated_at: row.status_updated_at,
  };
}

export function setAgentStatus(
  db: Db,
  handle: string,
  status: AgentStatus,
  focus: string | null,
): void {
  db.prepare(
    `UPDATE agents SET status = ?, focus = ?, status_updated_at = ?, last_seen_at = ? WHERE handle = ?`,
  ).run(status, focus, Date.now(), Date.now(), handle);
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
  const row = db.prepare(`SELECT * FROM agents WHERE handle = ?`).get(handle) as unknown as AgentRow | undefined;
  return row ? hydrate(row) : null;
}

export function listAgents(db: Db, includeOffline = false): Agent[] {
  const rows = db.prepare(`SELECT * FROM agents ORDER BY last_seen_at DESC`).all() as unknown as AgentRow[];
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
  kind?: MessageKind;
}

export interface SendResult {
  id: number;
  sent_at: number;
}

export function insertMessage(db: Db, input: SendInput): SendResult {
  const sent_at = Date.now();
  const kind: MessageKind = input.kind ?? 'chat';
  const info = db.prepare(
    `INSERT INTO messages (from_handle, to_handle, body, sent_at, kind) VALUES (?, ?, ?, ?, ?)`,
  ).run(input.from, input.to, input.body, sent_at, kind);
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
  ).all(query.to, since, limit) as unknown as MessageRow[];
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
  ).all(handle) as unknown as MessageRow[];
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
    kind: coerceKind(row.kind),
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

export interface JoinResult {
  room: Room;
  /** True on the first successful join by this handle; false on idempotent re-join. */
  was_new_member: boolean;
  /**
   * The system-authored announcement message posted to the room on a new
   * join. Present iff was_new_member is true. Callers are responsible for
   * fanning out notifyPeer to existing members.
   */
  system_message?: { id: number; sent_at: number; body: string };
}

/** Reserved from_handle used for room lifecycle announcements (joins etc.). */
export const SYSTEM_HANDLE = 'system';

interface RoomRow {
  name: string;
  created_at: number;
  created_by: string;
}

/**
 * Join a room, creating it if it doesn't exist. Idempotent — if the caller
 * is already a member, returns { was_new_member: false } and no side effects.
 * First joiner becomes the created_by.
 *
 * On a first-time join, inserts a system announcement message
 * (from='system', body='<handle> joined <room>') and anchors the new
 * joiner's read watermark AT that message id so they don't see their own
 * "joined" line. Existing members' watermarks are lower, so they see it.
 */
export function joinRoom(db: Db, room: string, handle: string): JoinResult {
  const now = Date.now();
  db.prepare(
    `INSERT INTO rooms (name, created_at, created_by) VALUES (?, ?, ?)
     ON CONFLICT(name) DO NOTHING`,
  ).run(room, now, handle);

  const existing = db.prepare(
    `SELECT joined_at FROM room_members WHERE room_name = ? AND handle = ?`,
  ).get(room, handle) as unknown as { joined_at: number } | undefined;

  if (existing) {
    return { room: hydrateRoom(db, room), was_new_member: false };
  }

  db.prepare(
    `INSERT INTO room_members (room_name, handle, joined_at) VALUES (?, ?, ?)`,
  ).run(room, handle, now);

  const body = `${handle} joined ${room}`;
  const sysInfo = db.prepare(
    `INSERT INTO messages (from_handle, to_handle, body, sent_at) VALUES (?, ?, ?, ?)`,
  ).run(SYSTEM_HANDLE, room, body, now);
  const sysId = Number(sysInfo.lastInsertRowid);

  // Anchor the new joiner's watermark AT the system message so they don't
  // see their own "joined" line. Existing members have lower watermarks
  // and will pick it up on their next room_inbox / notify.
  db.prepare(
    `INSERT INTO room_reads (room_name, handle, last_read_id) VALUES (?, ?, ?)
     ON CONFLICT(room_name, handle) DO UPDATE SET last_read_id = excluded.last_read_id`,
  ).run(room, handle, sysId);

  return {
    room: hydrateRoom(db, room),
    was_new_member: true,
    system_message: { id: sysId, sent_at: now, body },
  };
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

/**
 * Delete a room entirely. `rooms → room_members` cascades on FK; `room_reads`
 * and `messages` (to_handle = room name) are cleaned up here since neither
 * has an FK back to `rooms`. Idempotent — no error on unknown room.
 * Authorization is a caller-layer concern (shim tool checks membership).
 */
export function deleteRoom(db: Db, room: string): boolean {
  db.prepare(`DELETE FROM room_reads WHERE room_name = ?`).run(room);
  db.prepare(`DELETE FROM messages WHERE to_handle = ?`).run(room);
  const info = db.prepare(`DELETE FROM rooms WHERE name = ?`).run(room);
  return info.changes > 0;
}

/**
 * Boot a specific handle from a room. Removes membership + read watermark.
 * Returns true iff the target was actually a member. Authorization is a
 * caller-layer concern (shim tool checks the caller is themselves a member
 * and isn't booting themselves).
 */
export function bootFromRoom(db: Db, room: string, handle: string): boolean {
  const info = db.prepare(
    `DELETE FROM room_members WHERE room_name = ? AND handle = ?`,
  ).run(room, handle);
  db.prepare(
    `DELETE FROM room_reads WHERE room_name = ? AND handle = ?`,
  ).run(room, handle);
  return info.changes > 0;
}

export function isRoomMember(db: Db, room: string, handle: string): boolean {
  const row = db.prepare(
    `SELECT 1 AS x FROM room_members WHERE room_name = ? AND handle = ?`,
  ).get(room, handle) as unknown as { x: number } | undefined;
  return row !== undefined;
}

/** Members of a room, in join order. Includes offline members. */
export function roomMembers(db: Db, room: string): string[] {
  const rows = db.prepare(
    `SELECT handle FROM room_members WHERE room_name = ? ORDER BY joined_at ASC`,
  ).all(room) as unknown as { handle: string }[];
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
  ).all(handle) as unknown as RoomRow[];
  return rows.map((r) => hydrateRoomFromRow(db, r));
}

/** All rooms known to the bus (for /rooms --all). */
export function allRooms(db: Db): Room[] {
  const rows = db.prepare(
    `SELECT name, created_at, created_by FROM rooms ORDER BY name ASC`,
  ).all() as unknown as RoomRow[];
  return rows.map((r) => hydrateRoomFromRow(db, r));
}

function hydrateRoom(db: Db, name: string): Room {
  const row = db.prepare(
    `SELECT name, created_at, created_by FROM rooms WHERE name = ?`,
  ).get(name) as unknown as RoomRow | undefined;
  if (!row) throw new Error(`Room ${name} does not exist`);
  return hydrateRoomFromRow(db, row);
}

function hydrateRoomFromRow(db: Db, row: RoomRow): Room {
  const count = db.prepare(
    `SELECT COUNT(*) AS n FROM room_members WHERE room_name = ?`,
  ).get(row.name) as unknown as { n: number };
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
  ).get(room, handle) as unknown as { last_read_id: number } | undefined;
  const since = read?.last_read_id ?? 0;
  const rows = db.prepare(
    `SELECT * FROM messages
     WHERE to_handle = ? AND id > ?
     ORDER BY id ASC
     LIMIT ?`,
  ).all(room, since, Math.min(Math.max(limit, 1), 500)) as unknown as MessageRow[];
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

// ─────────────────────────────────────────────────────────────
// Admin: kick + clear
// ─────────────────────────────────────────────────────────────

/**
 * Remove an agent from the bus. Deletes:
 *   - the agents row
 *   - every room_members row for this handle
 *   - every room_reads row for this handle
 * Does NOT delete messages the agent authored or received — those become
 * orphaned references (rendered fine; the sender label just names a peer
 * that no longer exists). A running shim for the handle will re-register
 * on its next touch; kick again if that happens.
 * No-op (returns false) if the handle isn't registered.
 */
export function deleteAgent(db: Db, handle: string): boolean {
  const info = db.prepare('DELETE FROM agents WHERE handle = ?').run(handle);
  db.prepare('DELETE FROM room_members WHERE handle = ?').run(handle);
  db.prepare('DELETE FROM room_reads WHERE handle = ?').run(handle);
  return Number(info.changes) > 0;
}

/**
 * Delete all messages between two peers (both directions). Returns the
 * number of rows deleted.
 */
export function deleteDmMessages(db: Db, a: string, b: string): number {
  const info = db.prepare(
    `DELETE FROM messages
     WHERE (from_handle = ? AND to_handle = ?)
        OR (from_handle = ? AND to_handle = ?)`,
  ).run(a, b, b, a);
  return Number(info.changes);
}

/**
 * Delete every message posted to a room (including the SYSTEM join banners).
 * Also resets every member's read watermark to 0 so future messages don't
 * silently skip past a stale watermark. Returns the number of message rows
 * deleted.
 */
export function deleteRoomMessages(db: Db, room: string): number {
  const info = db.prepare('DELETE FROM messages WHERE to_handle = ?').run(room);
  db.prepare('UPDATE room_reads SET last_read_id = 0 WHERE room_name = ?').run(room);
  return Number(info.changes);
}
