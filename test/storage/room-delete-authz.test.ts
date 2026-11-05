import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { migrate } from '../../src/storage/db.js';
import * as dao from '../../src/storage/dao.js';

/**
 * Who may delete a room (#89), and the guarantee that every surface asks.
 *
 * 🛑 THE RULE USED TO BE A CALLER CONCERN AND THAT WAS THE DEFECT. The first
 * cut of #89 put the owner-only check in the web handler, and the four other
 * delete paths — the MCP tool agents actually use, both CLIs and the oneshot —
 * kept enforcing the old member-only rule. Found by claude1 on PR 125, who
 * counted four call sites; there were five.
 *
 * So the rule lives in `dao.deleteRoom`, which now takes the caller and
 * returns a verdict union. The chokepoint test at the bottom is what keeps a
 * sixth surface from reintroducing the bug.
 */

function db(): DatabaseSync {
  const d = new DatabaseSync(':memory:');
  migrate(d);
  for (const h of ['owner', 'member', 'stranger']) {
    dao.upsertAgent(d, { handle: h, pid: 1, session_id: h, display_name: h, metadata: {} });
  }

  return d;
}

/** `#room` owned by `owner`, with `member` also in it. First joiner owns it. */
function roomWithOwnerAndMember(d: DatabaseSync): void {
  dao.joinRoom(d, '#ops', 'owner');
  dao.joinRoom(d, '#ops', 'member');
  assert.equal(dao.roomOwner(d, '#ops'), 'owner', 'fixture did not establish ownership');
}

// ── the rule on its own ──────────────────────────────────────────────────

const V = (caller: string, owner: string | undefined, callerIsMember: boolean, ownerIsMember: boolean) =>
  dao.roomDeleteVerdict({ caller, owner, callerIsMember, ownerIsMember });

test('membership is checked before ownership, so a stranger never learns the owner', () => {
  assert.equal(V('me', 'them', false, true), 'not-a-member');
  assert.equal(V('me', 'them', false, false), 'not-a-member');
  // Even owning it does not help once you have left.
  assert.equal(V('me', 'me', false, false), 'not-a-member');
});

test('the owner is allowed, and a present non-owner is not', () => {
  assert.equal(V('me', 'me', true, true), 'allow');
  assert.equal(V('me', 'them', true, true), 'owner-only');
});

test('🛑 A DEPARTED OWNER FALLS BACK TO MEMBER-ONLY', () => {
  // The lockout case. Without this branch the room is undeletable forever,
  // which is strictly worse than the member-only rule this replaced.
  assert.equal(V('me', 'them', true, false), 'allow');
});

test('a room with no owner row cannot lock either', () => {
  // `created_by` is NOT NULL, so undefined means the room does not exist.
  assert.equal(V('me', undefined, true, false), 'allow');
});

// ── dao.deleteRoom, against a real database ──────────────────────────────

test('🛑 a member who does NOT own the room is refused, AND THE ROOM SURVIVES', () => {
  const d = db();
  roomWithOwnerAndMember(d);

  const r = dao.deleteRoom(d, '#ops', 'member');

  assert.deepEqual(r, { ok: false, reason: 'owner-only', owner: 'owner' });
  // THE POINT. A refusal that already deleted the row is not a refusal.
  assert.equal(dao.roomOwner(d, '#ops'), 'owner');
});

test('the owner may delete, and the messages go with it', () => {
  const d = db();
  roomWithOwnerAndMember(d);
  dao.insertMessage(d, { from: 'owner', to: '#ops', body: 'a secret' });
  const secrets = (): number => (d
    .prepare('SELECT COUNT(*) AS n FROM messages WHERE to_handle = ? AND body = ?')
    .get('#ops', 'a secret') as { n: number }).n;
  assert.equal(secrets(), 1, 'fixture never stored the message, so its deletion proves nothing');

  assert.deepEqual(dao.deleteRoom(d, '#ops', 'owner'), { ok: true });

  assert.equal(dao.roomOwner(d, '#ops'), undefined);
  assert.equal(secrets(), 0);
});

test('🛑 ONCE THE OWNER HAS LEFT, ANY MEMBER MAY DELETE — no room is ever locked', () => {
  const d = db();
  roomWithOwnerAndMember(d);
  dao.leaveRoom(d, '#ops', 'owner');
  // Both are denominators: if either were false this would pass for a reason
  // that is not the one under test.
  assert.equal(dao.roomOwner(d, '#ops'), 'owner', 'leaveRoom cleared created_by, so this case cannot arise');
  assert.equal(dao.isRoomMember(d, '#ops', 'owner'), false, 'the owner is still a member, so nothing is tested');

  assert.deepEqual(dao.deleteRoom(d, '#ops', 'member'), { ok: true });
});

test('a non-member is refused with not-a-member, which carries no owner handle', () => {
  const d = db();
  roomWithOwnerAndMember(d);

  const r = dao.deleteRoom(d, '#ops', 'stranger');

  // 🛑 THE SHAPE IS THE ASSERTION. `not-a-member` has no `owner` field at all,
  // so a caller cannot leak the handle to someone outside the room even by
  // mistake.
  assert.deepEqual(r, { ok: false, reason: 'not-a-member' });
  assert.equal(dao.roomOwner(d, '#ops'), 'owner');
});

test('an unknown room is not-found, not a refusal', () => {
  const d = db();

  // It used to return `false` here, the same value as "refused". A caller that
  // cannot tell them apart cannot report either one.
  assert.deepEqual(dao.deleteRoom(d, '#nope', 'owner'), { ok: false, reason: 'not-found' });
});

// ── the chokepoint ───────────────────────────────────────────────────────

/** Every `.ts`/`.tsx` file under `src/`. */
function sourceFiles(dir = 'src'): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (p.endsWith('.ts') || p.endsWith('.tsx')) out.push(p);
  }

  return out;
}

test('🛑 EVERY deleteRoom CALL SITE PASSES A CALLER — the chokepoint', () => {
  const calls: string[] = [];

  for (const f of sourceFiles()) {
    const src = readFileSync(f, 'utf8');
    for (const line of src.split('\n')) {
      if (!line.includes('deleteRoom(')) continue;
      if (line.includes('export function deleteRoom')) continue;   // the definition
      if (line.includes('deleteRoomMessages')) continue;           // a different function
      calls.push(`${f}: ${line.trim()}`);
    }
  }

  // ⚠️ THE DENOMINATOR. claude1's review counted four call sites and there
  // were five; an empty or short list here would pass every claim below by
  // checking nothing.
  assert.ok(calls.length >= 5, `only ${calls.length} deleteRoom call sites found; the scan has drifted`);

  // Three arguments means the caller was supplied. TypeScript already refuses
  // two, so this is the tripwire for someone widening the signature back.
  const twoArg = calls.filter((c) => /deleteRoom\([^,)]+,[^,)]+\)/.test(c));

  assert.deepEqual(twoArg, [], `a deleteRoom call omits the caller:\n${twoArg.join('\n')}`);
});

test('🛑 NOTHING OUTSIDE dao.ts DELETES FROM rooms DIRECTLY', () => {
  // The guard is only a chokepoint while `dao.deleteRoom` is the only way out.
  // Raw SQL elsewhere would walk straight past it.
  const offenders = sourceFiles()
    .filter((f) => f !== join('src', 'storage', 'dao.ts'))
    .filter((f) => /DELETE\s+FROM\s+rooms\b/i.test(readFileSync(f, 'utf8')));

  assert.deepEqual(offenders, [], `raw room deletion outside dao.ts: ${offenders.join(', ')}`);
});
