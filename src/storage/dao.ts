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
  reason: string;
  sessionId?: string | null;
}

interface ApprovalRow {
  id: number;
  agent_handle: string;
  supervisor_handle: string;
  requested: string | null;
  reason: string;
  session_id: string | null;
  created_at: number;
  answered_at: number | null;
  decision: string | null;
}

function toApproval(row: ApprovalRow): Approval {
  return {
    id: row.id,
    agentHandle: row.agent_handle,
    supervisorHandle: row.supervisor_handle,
    requested: row.requested,
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
      `INSERT INTO approvals (agent_handle, supervisor_handle, requested, reason, session_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.agentHandle,
      input.supervisorHandle,
      input.requested ?? null,
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
      `approval ${id} cannot be approved: the CLI did not name a command, so there is ` +
        'nothing to grant. It can be denied.',
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

  if (existing && existing.requested == null) {
    throw new UnnameableApprovalError(id);
  }

  const result = db
    .prepare(`UPDATE approvals SET answered_at = ?, decision = ? WHERE id = ? AND answered_at IS NULL`)
    .run(Date.now(), decision, id);

  return Number(result.changes) > 0;
}
