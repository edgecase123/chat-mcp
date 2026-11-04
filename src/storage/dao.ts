import type { Db } from './db.js';
import type { ClaimRow } from '../claims/lifecycle.js';

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
  context_used: number | null;
  context_total: number | null;
  context_reported_at: number | null;
  context_warned_threshold: number | null;
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
  context_used: number | null;
  context_total: number | null;
  context_reported_at: number | null;
  context_warned_threshold: number | null;
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

/**
 * Whether a pid names a running process.
 *
 * EPERM means it exists and belongs to another user, which is still alive.
 * ⚠️ Pid numbers are REUSED, so a long-dead incumbent can read as live. That
 * is why claiming a handle has a `force` escape hatch.
 */
export function isProcessAlive(pid: number | null): boolean {
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
    online: isProcessAlive(row.pid),
    status: coerceStatus(row.status),
    focus: row.focus,
    status_updated_at: row.status_updated_at,
    context_used: row.context_used,
    context_total: row.context_total,
    context_reported_at: row.context_reported_at,
    context_warned_threshold: row.context_warned_threshold,
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

export function setAgentContext(db: Db, handle: string, used: number, total: number): void {
  const now = Date.now();
  db.prepare(
    `UPDATE agents SET context_used = ?, context_total = ?, context_reported_at = ?, last_seen_at = ? WHERE handle = ?`,
  ).run(used, total, now, now, handle);
}

export function setAgentContextWarned(db: Db, handle: string, threshold: number | null): void {
  db.prepare(
    `UPDATE agents SET context_warned_threshold = ? WHERE handle = ?`,
  ).run(threshold, handle);
}

export interface RegisterInput {
  handle: string;
  display_name?: string | null;
  pid: number;
  session_id: string;
  metadata?: Record<string, unknown>;
  /**
   * Take the handle from a live incumbent anyway.
   *
   * The escape hatch for a reused pid, so recovery never requires editing
   * SQLite by hand.
   */
  force?: boolean;
}

/**
 * A second LIVE process tried to claim a handle that is already held.
 *
 * 🛑 REFUSED RATHER THAN MERGED. `inbox` and `room_inbox` mark messages read,
 * so two processes on one handle means whichever reads first consumes the mail
 * and the other sees `[]` — indistinguishable from "nothing arrived".
 *
 * `WakeListener.bind` already refuses a live socket rival for the same reason.
 * Registration did not, and `.mcp.json` hardcodes `--handle`, so a second
 * process launched in a consuming repo claimed its live session's identity by
 * accident.
 */
export class HandleClaimedError extends Error {
  constructor(
    readonly handle: string,
    readonly heldByPid: number | null,
  ) {
    super(
      `handle "${handle}" is already held by a live process (pid ${heldByPid ?? 'unknown'}). ` +
        `Refusing to take it: inbox marks messages read, so one of the two ` +
        `processes would silently consume the other's mail. ` +
        `Use a different --handle, or force the claim if that pid is stale.`,
    );
    this.name = 'HandleClaimedError';
  }
}

/**
 * Refuse the claim when a DIFFERENT live process holds the handle.
 *
 * Three cases are deliberately allowed through:
 *   - the same pid re-registering, which every shim does on boot;
 *   - a dead incumbent, which is debris a crash left behind;
 *   - an incumbent with no pid, because refusing on missing data would lock
 *     the handle permanently — a worse failure than the one this prevents.
 */
function refuseLiveRival(input: RegisterInput, incumbent: Agent | null): void {
  if (input.force) return;
  if (!incumbent || incumbent.pid == null) return;
  if (incumbent.pid === input.pid) return;
  if (!isProcessAlive(incumbent.pid)) return;

  throw new HandleClaimedError(input.handle, incumbent.pid);
}

/**
 * Write the claim, but ONLY if nobody changed the row since we read it.
 *
 * 🛑 THIS IS WHY THERE IS NO TRANSACTION. Reading the incumbent and then
 * writing leaves a window: two processes launching together both read "this
 * handle is free", both pass the guard, and both write — each believing it
 * owns the handle. That is the bug this guard removes, surviving the guard.
 * Found by claude1 reviewing this branch.
 *
 * ⚠️ WRAPPING IT IN `BEGIN` WOULD NOT HAVE FIXED IT. SQLite's plain `BEGIN` is
 * DEFERRED and takes no write lock, so both readers still get inside — proved
 * in `test/storage/claim-atomicity.test.ts`. `BEGIN IMMEDIATE` would work, but
 * a compare-and-swap is one statement and needs no lock at all.
 *
 * `IS` rather than `=` because the expected pid is often NULL, and `NULL = NULL`
 * is NULL in SQL.
 *
 * Returns false when the row moved under us, which the caller reports as the
 * conflict it is.
 */
export function writeClaim(db: Db, input: RegisterInput, expectedPid: number | null): boolean {
  // A forced claim is "take it regardless", so it must not also lose the race
  // to the very row it is overriding.
  const guard = input.force ? 'WHERE TRUE' : 'WHERE agents.pid IS @expected_pid';
  const now = Date.now();
  const metadata_json = input.metadata ? JSON.stringify(input.metadata) : null;

  const result = db
    .prepare(
      `INSERT INTO agents (handle, display_name, pid, session_id, registered_at, last_seen_at, metadata_json)
       VALUES (@handle, @display_name, @pid, @session_id, @now, @now, @metadata_json)
       ON CONFLICT(handle) DO UPDATE SET
         display_name  = excluded.display_name,
         pid           = excluded.pid,
         session_id    = excluded.session_id,
         last_seen_at  = excluded.last_seen_at,
         metadata_json = excluded.metadata_json
       ${guard}`,
    )
    .run({
      handle: input.handle,
      display_name: input.display_name ?? null,
      pid: input.pid,
      session_id: input.session_id,
      now,
      metadata_json,
      // Bound only when the guard clause references it. node:sqlite rejects a
      // named parameter the statement does not mention.
      ...(input.force ? {} : { expected_pid: expectedPid }),
    });

  return Number(result.changes) > 0;
}

export function upsertAgent(db: Db, input: RegisterInput): Agent {
  // ONE read, reused by both the liveness guard and the compare-and-swap, so
  // the value the guard judged is the value the write insists on.
  const incumbent = getAgent(db, input.handle);

  refuseLiveRival(input, incumbent);

  if (!writeClaim(db, input, incumbent?.pid ?? null)) {
    // The row moved between the read and the write, so a rival claimed it in
    // the window. Report the conflict rather than overwriting it.
    throw new HandleClaimedError(input.handle, getAgent(db, input.handle)?.pid ?? null);
  }

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

/**
 * How many DMs are waiting for `handle`.
 *
 * 🛑 MUST MIRROR `pendingInbox`'s filter. They are read together — the count
 * goes in a wake payload and the agent decides from it whether to call
 * `inbox` — so a count that includes what the read excludes sends an agent
 * looking for a message that is not there.
 */
export function pendingInboxCount(db: Db, to: string): number {
  const row = db.prepare(
    `SELECT COUNT(*) AS n FROM messages WHERE to_handle = ? AND read_at IS NULL`,
  ).get(to) as unknown as { n: number };

  return Number(row.n);
}

/**
 * Everything waiting for `handle`, across every channel.
 *
 * 🛑 ONE NOTIFY FILE PER HANDLE, SO ONE COUNT. An earlier cut dispatched on the
 * target's `#` prefix and counted that channel alone. A room send then reported
 * 1 while a DM also waited, which licensed the agent to skip the read — and the
 * DM was gone, because this very message had overwritten the file.
 *
 * A per-channel count is worse than no count: absent means "read if you care",
 * and 1 means "there is nothing else".
 */
export function totalUnreadFor(db: Db, handle: string): number {
  let total = pendingInboxCount(db, handle);
  for (const room of myRooms(db, handle)) {
    total += roomUnreadCount(db, room.name, handle);
  }

  return total;
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
  /** The configured style name, or null when the room has no preference (#92). */
  style: string | null;
  /** The markdown behind `style: 'custom'`, so the web editor can prefill it. */
  style_custom: string | null;
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
  style: string | null;
  style_custom: string | null;
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
    `SELECT r.name, r.created_at, r.created_by, r.style, r.style_custom
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
    `SELECT name, created_at, created_by, style, style_custom FROM rooms ORDER BY name ASC`,
  ).all() as unknown as RoomRow[];
  return rows.map((r) => hydrateRoomFromRow(db, r));
}

function hydrateRoom(db: Db, name: string): Room {
  const row = db.prepare(
    `SELECT name, created_at, created_by, style, style_custom FROM rooms WHERE name = ?`,
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
    style: row.style ?? null,
    style_custom: row.style_custom ?? null,
  };
}

/**
 * Unread messages for a (room, handle) pair. Uses the per-member watermark
 * so each member reads independently. Does NOT advance the watermark —
 * call `advanceRoomRead` after presenting the messages.
 *
 * 🛑 THE CALLER'S OWN POSTS ARE EXCLUDED. `room_send` does not advance the
 * sender's watermark, while the web UI and the CLI both do, so without this
 * an agent got its own message back as unread and paid to read it again.
 */
export function roomWatermark(db: Db, room: string, handle: string): number {
  const read = db.prepare(
    `SELECT last_read_id FROM room_reads WHERE room_name = ? AND handle = ?`,
  ).get(room, handle) as unknown as { last_read_id: number } | undefined;

  return read?.last_read_id ?? 0;
}

/**
 * The id floor for a read. `sinceId` can only ever raise it.
 *
 * 🛑 A MAX, NEVER A REPLACEMENT. A stale `sinceId` below the watermark would
 * otherwise resurrect messages the caller already consumed.
 */
function readFloor(db: Db, room: string, handle: string, sinceId?: number): number {
  return Math.max(roomWatermark(db, room, handle), sinceId ?? 0);
}

/**
 * The id a `room_inbox` read may advance the watermark to, or `undefined` when
 * it may not advance at all.
 *
 * 🛑 A `sinceId` ABOVE THE WATERMARK LEAVES A GAP, and advancing over a gap
 * marks messages read that were never shown. A targeted recovery read must
 * therefore consume nothing.
 */
export function safeRoomAdvanceId(
  db: Db,
  room: string,
  handle: string,
  sinceId: number | undefined,
  returnedIds: number[],
): number | undefined {
  if (sinceId !== undefined && sinceId > roomWatermark(db, room, handle)) return undefined;
  if (returnedIds.length === 0) return undefined;

  return Math.max(...returnedIds);
}

/**
 * 🛑 `since_id` WITHOUT A ROOM IS INCOHERENT, NOT MERELY UNHELPFUL.
 *
 * Ids are global; watermarks are per room. One id floors every room, so the
 * caller is served messages from rooms it never named. A per-room gap test
 * would only make that waste correct — a known id belongs to one known room.
 */
export function assertRoomInboxQuery(room: string | undefined, sinceId: number | undefined): void {
  if (sinceId !== undefined && room === undefined) {
    throw new Error(
      'since_id requires room. Message ids are global but watermarks are per room, so an unscoped since_id returns messages from rooms you did not ask about and marks none of them read.',
    );
  }
}

export function roomUnread(
  db: Db,
  room: string,
  handle: string,
  limit = 50,
  sinceId?: number,
): Message[] {
  const since = readFloor(db, room, handle, sinceId);
  const rows = db.prepare(
    `SELECT * FROM messages
     WHERE to_handle = ? AND id > ? AND from_handle != ?
     ORDER BY id ASC
     LIMIT ?`,
  ).all(room, since, handle, Math.min(Math.max(limit, 1), 500)) as unknown as MessageRow[];
  return rows.map(toMessage);
}

/**
 * How many unread, without materialising them. `roomUnread` caps its rows,
 * so its length is a page size, not a count — a sidebar badge reading 50
 * when 300 are waiting is worse than no badge.
 */
export function roomUnreadCount(
  db: Db,
  room: string,
  handle: string,
  sinceId?: number,
): number {
  const since = readFloor(db, room, handle, sinceId);
  const row = db.prepare(
    // Must carry the SAME filter as `roomUnread`, or the sidebar badge reads
    // one number and opening the room produces another.
    `SELECT COUNT(*) AS n FROM messages
     WHERE to_handle = ? AND id > ? AND from_handle != ?`,
  ).get(room, since, handle) as unknown as { n: number };

  return Number(row.n);
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
 * Split the named handles into what may be pruned, what is live, and what is
 * not registered at all.
 *
 * 🛑 ONLINE IS THE ONE STATE PRUNING MUST REFUSE. Freeing a live agent's handle
 * lets a second process claim it, and `inbox` marks messages read — so one of
 * the two would silently consume the other's mail.
 */
export function partitionPrunable(
  db: Db,
  handles: readonly string[],
): { prunable: string[]; online: string[]; absent: string[] } {
  const byHandle = new Map(listAgents(db, true).map((a) => [a.handle, a]));
  const prunable: string[] = [];
  const online: string[] = [];
  const absent: string[] = [];
  for (const h of handles) {
    const agent = byHandle.get(h);
    if (agent === undefined) absent.push(h);
    else if (agent.online) online.push(h);
    else prunable.push(h);
  }

  return { prunable, online, absent };
}

/**
 * Delete the named agents, returning the handles that actually existed.
 *
 * 🛑 EXACT NAMES ONLY, NEVER A PREFIX. `perm-` reads as a safe pattern until a
 * real peer's handle starts with it, and freeing a live agent's handle lets
 * another process claim it. Reporting what was deleted rather than what was
 * asked for is what makes a typo visible.
 */
export function pruneAgents(db: Db, handles: readonly string[]): string[] {
  return handles.filter((h) => deleteAgent(db, h));
}

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

// ── Approvals ────────────────────────────────────────────────────────────

/**
 * A permission request a supervised agent is blocked on.
 *
 * 🛑 AN APPROVAL IS A MODAL WITH TWO OUTCOMES, NOT A SENTENCE. A denied child
 * is instructed not to retry for the rest of its session, so it stops partway
 * through and nobody is told. This is how the request reaches a human.
 */
export interface Approval {
  readonly id: number;
  /** The supervised child that was refused. */
  readonly agentHandle: string;
  /** The supervisor to wake once the operator has answered. */
  readonly supervisorHandle: string;
  /**
   * The command, VERBATIM, or null when the CLI did not name one.
   *
   * 🛑 NULL IS NOT A PLACEHOLDER. It is what the operator approves AND what
   * goes into the allowlist, so a stand-in string grants nothing and reads
   * as a real request. A null request may be DENIED but never APPROVED.
   */
  readonly requested: string | null;
  /**
   * The allowlist entry that grants exactly this invocation.
   *
   * 🛑 NOT THE SAME STRING AS `requested`. That is prose for a human; this
   * is what `--allowedTools` understands. NULL when the pairing failed, and
   * an approval without one cannot widen anything.
   */
  readonly grant: string | null;

  /**
   * Every equivalent spelling of `grant`, including it.
   *
   * 🛑 ALL OF THEM ARE ALLOWLISTED. `/var/x` and `/private/var/x` are the
   * same file, and granting only the spelling the operator happened to see
   * leaves the other one denied — measured live.
   */
  readonly grantForms: string[];

  /**
   * What the child was allowed to use when it was refused.
   *
   * 🛑 NULL MEANS UNRECORDED, NOT "nothing was allowed". Rows filed before
   * this was captured all had a non-empty allowlist nobody wrote down, and
   * reading them as `[]` would assert a clean experiment that never happened.
   */
  readonly allowlist: string[] | null;

  /** The whole denial text, so the UI can quote the reason rather than retell it. */
  readonly reason: string;
  /** The child session to `--resume`, or null when it is not known. */
  readonly sessionId: string | null;
  readonly createdAt: number;
  readonly answeredAt: number | null;
  readonly decision: 'approve' | 'deny' | null;
}

export interface ApprovalInput {
  agentHandle: string;
  supervisorHandle: string;
  requested: string | null;
  grant?: string | null;
  grantForms?: readonly string[];
  allowlist?: readonly string[];
  reason: string;
  sessionId?: string | null;
}

interface ApprovalRow {
  id: number;
  agent_handle: string;
  supervisor_handle: string;
  requested: string | null;
  allowlist: string | null;
  grant_entry: string | null;
  grant_forms: string | null;
  reason: string;
  session_id: string | null;
  created_at: number;
  answered_at: number | null;
  decision: string | null;
}

/**
 * The stored spellings, falling back to the single grant.
 *
 * ⚠️ A ROW WRITTEN BEFORE MIGRATION 10 HAS NO FORMS, and must still be
 * approvable — returning an empty list there would make every historic card
 * un-grantable.
 */
function parseForms(raw: string | null, fallback: string | null): string[] {
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) return parsed.filter((x): x is string => typeof x === 'string');
    } catch {
      // A corrupt value must not make the row unreadable.
    }
  }

  return fallback ? [fallback] : [];
}

function toApproval(row: ApprovalRow): Approval {
  return {
    id: row.id,
    agentHandle: row.agent_handle,
    supervisorHandle: row.supervisor_handle,
    requested: row.requested,
    grant: row.grant_entry,
    grantForms: parseForms(row.grant_forms, row.grant_entry),
    allowlist: row.allowlist === null ? null : (JSON.parse(row.allowlist) as string[]),
    reason: row.reason,
    sessionId: row.session_id,
    createdAt: row.created_at,
    answeredAt: row.answered_at,
    decision: row.decision === 'approve' || row.decision === 'deny' ? row.decision : null,
  };
}

export function insertApproval(db: Db, input: ApprovalInput): number {
  const result = db
    .prepare(
      `INSERT INTO approvals (agent_handle, supervisor_handle, requested, grant_entry, grant_forms, allowlist, reason, session_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.agentHandle,
      input.supervisorHandle,
      input.requested ?? null,
      input.grant ?? null,
      input.grantForms && input.grantForms.length > 0
        ? JSON.stringify([...input.grantForms])
        : null,
      // ⚠️ UNDEFINED STAYS NULL. An omitted allowlist is unrecorded, and an
      // empty one is a real state a caller may want to record, so the two
      // must not collapse.
      input.allowlist === undefined ? null : JSON.stringify([...input.allowlist]),
      input.reason,
      input.sessionId ?? null,
      Date.now(),
    );

  return Number(result.lastInsertRowid);
}

/**
 * Unanswered requests, OLDEST FIRST, because that is the order to answer them.
 *
 * Omitting the handle returns every supervisor's, which is what one operator
 * watching several agents needs.
 */
export function pendingApprovals(db: Db, agentHandle?: string): Approval[] {
  const rows = agentHandle
    ? db
        .prepare(
          `SELECT * FROM approvals WHERE answered_at IS NULL AND agent_handle = ? ORDER BY id ASC`,
        )
        .all(agentHandle)
    : db.prepare(`SELECT * FROM approvals WHERE answered_at IS NULL ORDER BY id ASC`).all();

  return (rows as unknown as ApprovalRow[]).map(toApproval);
}

export function getApproval(db: Db, id: number): Approval | null {
  const row = db.prepare(`SELECT * FROM approvals WHERE id = ?`).get(id) as unknown as
    | ApprovalRow
    | undefined;

  return row ? toApproval(row) : null;
}

/**
 * Record a decision. Returns false when it was already answered.
 *
 * 🛑 A COMPARE-AND-SWAP, FOR THE SAME REASON THE HANDLE CLAIM NEEDED ONE. Two
 * browser tabs are the normal case, and check-then-write is not atomic. The
 * worst outcome is a second click upgrading a `deny` to an `approve`, so the
 * `answered_at IS NULL` clause is what refuses it rather than a prior read.
 */
/**
 * 🛑 AN UNNAMED REQUEST CANNOT BE APPROVED, ONLY DENIED.
 *
 * Approving one grants a string nobody can act on — measured: a placeholder
 * went into `--allowedTools`, the retry was denied, and a second card
 * appeared. Deny still works, because stopping something you cannot name is
 * always a safe answer.
 */
export class UnnameableApprovalError extends Error {
  constructor(readonly id: number) {
    super(
      `approval ${id} cannot be approved: no allowlist entry could be derived from the ` +
        'refusal, so approving it would permit nothing. It can be denied.',
    );
    this.name = 'UnnameableApprovalError';
  }
}

export function answerApproval(db: Db, id: number, decision: 'approve' | 'deny'): boolean {
  // ⚠️ ONLY WHEN THE ROW EXISTS. `?.requested == null` is also true for an
  // approval that is not there, so the first version threw
  // UnnameableApprovalError for a missing id instead of returning false —
  // "no such approval" would have been reported as "cannot be approved".
  const existing = decision === 'approve' ? getApproval(db, id) : null;

  // 🛑 THE TEST IS `grant`, NOT `requested`. A row can name a command in
  // prose and still carry no allowlist entry — approving that permits
  // nothing and the agent is denied again, which is the loop lee hit.
  if (existing && existing.grant == null) {
    throw new UnnameableApprovalError(id);
  }

  const result = db
    .prepare(`UPDATE approvals SET answered_at = ?, decision = ? WHERE id = ? AND answered_at IS NULL`)
    .run(Date.now(), decision, id);

  return Number(result.changes) > 0;
}

// ---------------------------------------------------------------------------
// Conversation style, per room and per peer (#92)
// ---------------------------------------------------------------------------

/**
 * 🛑 THE PRESET TEXT RIDES IN EVERY INBOX CALL THAT HAS ONE SET, so it is
 * deliberately short. The operator's own style guide is hundreds of words and
 * belongs in `custom`, where they pay for it knowingly.
 */
export const STYLE_PRESETS: Record<string, string> = {
  // 🛑 NO `normal` PRESET. It pushed ~14 words telling an agent to write the way
  // it already writes, and could only matter as an override of a stronger
  // default — which it would lose, because this repo's operator has a style
  // guide injected into EVERY message by a hook. Dropped on lee's call: "drop
  // normal". `none` already means "no instruction".
  succinct:
    'Answer in the first line. One idea per sentence. Rank rather than list. No preamble. Keep it under ten lines.',
};

export type ResolvedStyle = { style: string; text: string };

export function assertStyleName(style: string): void {
  if (style !== 'custom' && STYLE_PRESETS[style] === undefined) {
    const known = [...Object.keys(STYLE_PRESETS), 'custom'].join(', ');
    throw new Error(`Unknown style "${style}". Known styles: ${known}`);
  }
}

/**
 * Styles are per-ROOM. A peer target is refused.
 *
 * 🛑 `agents.style` EXISTS AND NOTHING READS IT. `setAgentStyle` writes it and
 * `inbox` pushes no style block, so before this a peer style was accepted,
 * stored, and silently did nothing — a setting that reports success and
 * changes behaviour not at all.
 *
 * lee, 2026-11-04, on closing PR 100 rather than wiring the read: *"skip the
 * style with peers. agents can just be governed by their own skills"*. The
 * columns stay in case that reverses; the write path does not.
 *
 * Lives here rather than in the tool because no test in this repo drives an
 * MCP tool handler, and a rule with no test is one that gets deleted by
 * accident.
 */
export function assertStyleTarget(target: string): void {
  if (target.startsWith('#')) return;

  throw new Error(
    `Conversation styles are per-room only. "${target}" is a peer, and a peer style would be stored and never delivered. Set the style on a #room, or govern the agent through its own skill.`,
  );
}

/** 64 KB matches the message body cap, so a style cannot outgrow a post. */
export const STYLE_CUSTOM_MAX_BYTES = 65536;

export function assertStyleCustom(style: string, custom: string | undefined): void {
  if (style === 'custom') {
    if (custom === undefined || custom.trim() === '') {
      throw new Error('style "custom" requires non-empty markdown in `custom`.');
    }
    if (Buffer.byteLength(custom, 'utf8') > STYLE_CUSTOM_MAX_BYTES) {
      throw new Error(`Custom style exceeds ${STYLE_CUSTOM_MAX_BYTES} bytes.`);
    }
  }
}

export function roomExists(db: Db, room: string): boolean {
  const row = db.prepare('SELECT 1 AS ok FROM rooms WHERE name = ?').get(room) as unknown as
    | { ok: number }
    | undefined;

  return row !== undefined;
}

export function setRoomStyle(db: Db, room: string, style: string | null, custom?: string): void {
  db.prepare('UPDATE rooms SET style = ?, style_custom = ? WHERE name = ?').run(
    style,
    style === 'custom' ? (custom ?? null) : null,
    room,
  );
}

export function setAgentStyle(db: Db, handle: string, style: string | null, custom?: string): void {
  db.prepare('UPDATE agents SET style = ?, style_custom = ? WHERE handle = ?').run(
    style,
    style === 'custom' ? (custom ?? null) : null,
    handle,
  );
}

/**
 * The style text to push, or undefined when none is set.
 *
 * 🛑 `custom` REPLACES the preset rather than layering on it. Layering means two
 * instructions that can contradict, and the operator writing custom markdown is
 * already saying exactly what they want.
 */
export function resolveStyle(db: Db, table: 'rooms' | 'agents', key: string): ResolvedStyle | undefined {
  const column = table === 'rooms' ? 'name' : 'handle';
  const row = db
    .prepare(`SELECT style, style_custom FROM ${table} WHERE ${column} = ?`)
    .get(key) as unknown as { style: string | null; style_custom: string | null } | undefined;

  if (!row || row.style === null) return undefined;

  if (row.style === 'custom') {
    // A 'custom' row with no markdown is a half-written setting, not a style.
    // Pushing an empty instruction reads as "no preference" and is worse than
    // pushing nothing, because the row says one is configured.
    if (!row.style_custom || row.style_custom.trim() === '') return undefined;
    return { style: 'custom', text: row.style_custom };
  }

  const preset = STYLE_PRESETS[row.style];

  return preset === undefined ? undefined : { style: row.style, text: preset };
}

/**
 * The style blocks to push alongside a room_inbox result.
 *
 * 🛑 EXTRACTED SO IT CAN BE TESTED. Nothing in this repo's 650 tests drives an
 * MCP tool handler, so logic left inside one is logic with no test. The tool
 * keeps a single line of glue.
 *
 * Empty for rooms with no style, which is every room on every existing
 * database — so the unset response stays byte-identical.
 */
export function styleBlocksForRooms(db: Db, rooms: string[]): { type: 'text'; text: string }[] {
  const blocks: { type: 'text'; text: string }[] = [];

  for (const room of rooms) {
    const resolved = resolveStyle(db, 'rooms', room);

    if (resolved) {
      blocks.push({
        type: 'text',
        text: `Conversation style for ${room} (${resolved.style}) — follow it in this room:\n\n${resolved.text}`,
      });
    }
  }

  return blocks;
}

/**
 * The order the CLI cycles a room's style through.
 *
 * 🛑 `custom` IS ONLY REACHABLE WHEN MARKDOWN ALREADY EXISTS. A terminal
 * cannot prompt for multi-line markdown mid-cycle, so cycling onto an empty
 * `custom` would set a style that pushes nothing — the half-written state
 * `resolveStyle` already refuses. Markdown is set through `set_style`.
 */
/** Whether a room has custom markdown stored, which is what makes `custom` reachable in the CLI cycle. */
export function hasCustomStyle(db: Db, room: string): boolean {
  const row = db.prepare('SELECT style_custom FROM rooms WHERE name = ?').get(room) as unknown as
    | { style_custom: string | null }
    | undefined;

  return typeof row?.style_custom === 'string' && row.style_custom.trim() !== '';
}

export function nextStyle(current: string | null, hasCustom: boolean): string | null {
  const order: (string | null)[] = [null, 'succinct'];

  if (hasCustom) order.push('custom');

  const at = order.indexOf(current);

  // An unknown stored value — a preset since removed, say — CLEARS rather than
  // advancing. "Cycles to the start" was the first wording and it is ambiguous:
  // index 0 is `null`, not the first named style, and my own test read it the
  // other way.
  return order[at === -1 ? 0 : (at + 1) % order.length] ?? null;
}

/* ------------------------------------------------------------------------- *
 * #101 — claims on shared resources
 *
 * 🛑 THESE FUNCTIONS DECIDE NOTHING. Every rule about conflict, renewal,
 * expiry and ownership lives in `src/claims/lifecycle.ts`, pure and tested
 * without a database. A lock that is wrong is silent, so the logic has to be
 * reachable by a unit test rather than only by two agents colliding.
 * ------------------------------------------------------------------------- */

/**
 * The newest claim row for a resource, live or not.
 *
 * 🛑 NEWEST, NOT NEWEST-LIVE. `decideClaim` needs to tell an expired claim
 * (a failsafe fired, say so) from a released one (a clean handover, say
 * nothing), and a query that filters to live rows throws that away.
 */
export function latestClaim(db: Db, resource: string): ClaimRow | null {
  const row = db
    .prepare('SELECT * FROM claims WHERE resource = ? ORDER BY id DESC LIMIT 1')
    .get(resource) as unknown as ClaimRow | undefined;

  return row ?? null;
}

/**
 * Every claim still held at `now`, newest first.
 *
 * 🛑 NO PER-RESOURCE MAX(id). A duplicate must show as two holders, because
 * naming one and reporting no conflict is worse than the chat scrollback this
 * table replaced. `released_at IS NULL` is what keeps a handover to one row.
 */
export function liveClaims(db: Db, now: number): ClaimRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM claims c
        WHERE c.released_at IS NULL AND c.expires_at > ?
        ORDER BY c.id DESC`,
    )
    .all(now) as unknown as ClaimRow[];

  return rows;
}

/**
 * Write a claim, but ONLY if the resource is still free.
 *
 * 🛑 THIS IS THE COMPARE-AND-SWAP, AND IT IS WHY THERE IS NO TRANSACTION.
 * Reading the newest row and then inserting leaves a window: two agents
 * claiming together both read "free", both pass `decideClaim`, and both write.
 * Same bug, same remedy and the same reasoning as `writeClaim` above.
 *
 * ⚠️ A UNIQUE INDEX CANNOT DO THIS. "One live claim per resource" is partly a
 * statement about the clock, and an index cannot read `now`.
 *
 * Returns null when a rival got in first, which the caller reports as the
 * conflict it is.
 */
export function insertClaim(
  db: Db,
  input: { resource: string; holder: string; note: string | null; claimed_at: number; expires_at: number },
): ClaimRow | null {
  const info = db
    .prepare(
      `INSERT INTO claims (resource, holder, note, claimed_at, expires_at)
       SELECT @resource, @holder, @note, @claimed_at, @expires_at
        WHERE NOT EXISTS (
          SELECT 1 FROM claims
           WHERE resource = @resource AND released_at IS NULL AND expires_at > @claimed_at
        )`,
    )
    .run({ ...input });

  if (Number(info.changes) === 0) return null;

  return latestClaimById(db, Number(info.lastInsertRowid));
}

/**
 * Extend a live claim's expiry in place, so the row keeps its claimed_at.
 *
 * 🛑 THE SAME SWAP, BECAUSE A RENEWAL HAS THE SAME WINDOW. Between reading its
 * own live claim and writing the new expiry, the claim can lapse and a rival
 * can take it over — and an UPDATE by id alone then REVIVES the dead row,
 * leaving two live claims with the insert already atomic.
 *
 * Returns null when the row is no longer live, or no longer the caller's.
 */
export function renewClaim(
  db: Db,
  input: { id: number; holder: string; expires_at: number; now: number },
): ClaimRow | null {
  const info = db
    .prepare(
      `UPDATE claims SET expires_at = @expires_at
        WHERE id = @id AND holder = @holder AND released_at IS NULL AND expires_at > @now`,
    )
    .run({ ...input });

  if (Number(info.changes) === 0) return null;

  return latestClaimById(db, input.id);
}

/** Mark a claim released. Returns false if the row was already released. */
export function releaseClaim(db: Db, id: number, released_at: number): boolean {
  const info = db
    .prepare('UPDATE claims SET released_at = ? WHERE id = ? AND released_at IS NULL')
    .run(released_at, id);

  return Number(info.changes) > 0;
}

function latestClaimById(db: Db, id: number): ClaimRow {
  const row = db.prepare('SELECT * FROM claims WHERE id = ?').get(id) as unknown as ClaimRow | undefined;
  if (row === undefined) throw new Error(`claim ${id} vanished immediately after being written`);

  return row;
}

/* ------------------------------------------------------------------------- *
 * #102 — searching the transcript
 *
 * 🛑 READ ONLY. NOTHING HERE WRITES `room_reads`.
 *
 * That is the hazard #102 names: `room_inbox` advances a per-member read
 * watermark, so a search routed through it would silently mark messages read —
 * the very thing that makes re-reading a room expensive today.
 * `search-no-watermark.test.ts` asserts the pointer is untouched.
 *
 * 🛑 NO NEW INDEX, DELIBERATELY. A leading-wildcard `LIKE '%term%'` cannot use
 * one, so an index on `body` would be theatre — it would cost writes and serve
 * nothing. The scoped case rides `ix_messages_to_read`'s leading column.
 * FTS5 would change this and `node:sqlite` does not ship it (#102).
 * ------------------------------------------------------------------------- */

export interface SearchHit {
  readonly id: number;
  readonly from_handle: string;
  readonly to_handle: string;
  readonly body: string;
  readonly sent_at: number;
}

export function searchMessages(
  db: Db,
  input: { pattern: string; target?: string; limit: number },
): SearchHit[] {
  // ⚠️ `ESCAPE '\'` IS NOT OPTIONAL. Without it the backslashes `likePattern`
  // inserts are matched literally, so a query containing % finds nothing
  // instead of finding too much — wrong in the other direction, still silent.
  const where = input.target === undefined ? '' : 'AND to_handle = ?';
  const sql = `SELECT id, from_handle, to_handle, body, sent_at
                 FROM messages
                WHERE body LIKE ? ESCAPE '\\' ${where}
                ORDER BY id DESC
                LIMIT ?`;

  const args: (string | number)[] =
    input.target === undefined ? [input.pattern, input.limit] : [input.pattern, input.target, input.limit];

  return db.prepare(sql).all(...args) as unknown as SearchHit[];
}
