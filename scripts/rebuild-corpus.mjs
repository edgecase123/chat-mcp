#!/usr/bin/env node
/**
 * Rebuild `test/fixtures/captured-refusals.json` from the live database.
 *
 * 🛑 A SCRIPT, NOT AN INLINE ONE-LINER. This was ad-hoc `node -e` four times
 * in one session, and one of those versions silently DISCARDED the only
 * record carrying an allowlist — its dedup kept the first match per key, so
 * an older unrecorded row outranked the new recorded one. An inline rebuild
 * cannot be reviewed, cannot be diffed, and cannot be tested.
 *
 *   node --import tsx scripts/rebuild-corpus.mjs
 *
 * It prints real coverage, because that number is what the fixture is worth.
 */

import { writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/storage/db.ts';
import { normalise } from '../test/support/would-refuse.ts';
import { carryOver } from '../test/support/carry-over.ts';
import { corpusAge, maxAgeDays } from '../test/support/corpus-age.ts';

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'test',
  'fixtures',
  'captured-refusals.json',
);

/** The command inside an allowlist entry: `Bash(rm x)` -> `rm x`. */
const inner = (entry) => {
  const m = /^[A-Za-z_]\w*\((.*)\)$/s.exec(entry);

  return m === null ? entry : m[1];
};

const db = openDb();
const rows = db
  .prepare(
    `SELECT id, grant_entry, reason, allowlist FROM approvals
     WHERE supervisor_handle LIKE 'e2e-%' OR supervisor_handle LIKE 'cap-%'
     ORDER BY id`,
  )
  .all();

/**
 * When each approval happened, keyed by id, for EVERY row rather than the
 * filtered set above.
 *
 * 🛑 THE FILTER WOULD LEAVE NINE PERMITS UNDATED. It selects the rows a
 * refusal is derived from. A permit is carried over from a pending file and
 * its approval was answered under a handle the filter does not match, so
 * stamping one needs the whole table.
 *
 * 🛑 THE DATE IS LOOKED UP, NEVER WRITTEN BY HAND. A record whose id is not
 * in the database stays UNSTAMPED and `corpus-staleness.test.ts` names it.
 * A plausible hand-written date is how an age check certifies a memory.
 */
const capturedAtById = new Map(
  db
    .prepare('SELECT id, created_at FROM approvals')
    .all()
    .map((r) => [r.id, new Date(Number(r.created_at)).toISOString()]),
);

/** Stamp one record from its own approval id(s), or leave it unstamped. */
const stamp = (record) => {
  const ids = record.approvalIds ?? (record.approvalId === undefined ? [] : [record.approvalId]);
  const stamps = ids.map((id) => capturedAtById.get(id)).filter((s) => s !== undefined);

  // ⚠️ THE LATEST OF THEM. A `refused_under_grant` answers several approvals
  // before its target is checked, so the measurement is as old as its newest
  // input, not its first.
  return stamps.length === 0 ? record : { ...record, capturedAt: stamps.sort().at(-1) };
};

const best = new Map();

for (const r of rows) {
  const m = String(r.reason).match(/What required approval: ([\s\S]*)/);
  if (!m || !r.grant_entry) continue;

  const record = {
    outcome: 'refused',
    approvalId: r.id,
    attempted: normalise(inner(r.grant_entry)),
    allowlist: r.allowlist ? JSON.parse(r.allowlist) : null,
    refusal: normalise(m[1]),
  };

  const key = `${record.refusal.slice(0, 70)}|${record.attempted}`;
  const held = best.get(key);

  // 🛑 PREFER A RECORD THAT CARRIES ITS ALLOWLIST. Keeping the first match is
  // the bug this script exists to prevent: a row with no allowlist is SILENT
  // in the fixture, so letting an older one win throws the record away.
  if (!held || (held.allowlist === null && record.allowlist !== null)) best.set(key, record);
}

const refused = [...best.values()];

/**
 * 🛑 THE OTHER TWO OUTCOMES ARE CARRIED OVER, NOT DERIVED. Neither is in
 * the approvals table. A permit's proof is an observed side effect, and a
 * `refused_under_grant`'s proof is the ABSENCE of one after an approval, so
 * both state their evidence and state that it is historical.
 *
 * 🛑 AND A PENDING FILE IS MERGED, NOT LEFT TO ROT. For one commit nothing
 * read the permits file — four permits that cost real money bought the
 * instrument nothing, and the reported coverage counted them anyway. Found by
 * claude1 on PR 43. Same shape as the dedup slip: the measurement happened
 * and the corpus missed it.
 *
 * The merge itself is `test/support/carry-over.ts`, extracted and tested
 * because the third outcome made this a second copy of the one step that has
 * already discarded a paid-for measurement twice.
 */
const pendingPath = (name) =>
  join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', name);

const PENDING_PERMITS = pendingPath('captured-permits.pending.json');
const PENDING_UNDER_GRANT = pendingPath('captured-refused-under-grant.pending.json');

const readRows = (file) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : []);

const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'));
const pendingPermits = readRows(PENDING_PERMITS);
const pendingUnderGrant = readRows(PENDING_UNDER_GRANT);

const permits = carryOver({
  outcome: 'permitted',
  keyOf: (r) => `${r.attempted}|${r.allowlistEntry}`,
  existing: fixture,
  pending: pendingPermits,
});

// ⚠️ SORTED, BECAUSE `sameSet` IS ORDER-INSENSITIVE. Keying on the written
// order would file one measurement twice under two spellings of one set.
const underGrant = carryOver({
  outcome: 'refused_under_grant',
  keyOf: (r) => `${r.attempted}|${[...r.allowlist].sort().join('\u0000')}`,
  existing: fixture,
  pending: pendingUnderGrant,
});

const records = [...refused, ...underGrant, ...permits].map(stamp);

writeFileSync(FIXTURE, `${JSON.stringify(records, null, 2)}\n`);

const recorded = refused.filter((r) => r.allowlist !== null);
const total = refused.length + underGrant.length + permits.length;

console.log(`wrote ${total} records`);
console.log(`  refusals with a recorded allowlist : ${recorded.length}`);
console.log(`  refused UNDER a grant              : ${underGrant.length}`);
console.log(`  measured permits                   : ${permits.length}`);
console.log(`  records present but SILENT         : ${refused.length - recorded.length}`);
console.log(`\nreal coverage is ${recorded.length + underGrant.length + permits.length}, not ${total}.`);

/**
 * 🛑 AGE IS PART OF WHAT THE FIXTURE IS WORTH, so it is printed beside
 * coverage. A corpus answers from what children did on a given day, and a
 * CLI change can make a recorded refusal wrong without changing a byte here.
 * `corpus-staleness.test.ts` enforces the ceiling; this just says it out loud
 * at the moment someone is looking.
 */
const age = corpusAge(records, Date.now());

console.log(`\nnewest capture is ${age.ageDays} day(s) old, ceiling ${maxAgeDays()}.`);

if (age.unstamped > 0) {
  console.log(`  ⚠️ ${age.unstamped} of ${age.total} records carry NO date — their approval id is not in the database.`);
}

// 🛑 CONSUMED, so a merged file cannot be merged twice or read as still waiting.
for (const [file, rows, label] of [
  [PENDING_PERMITS, pendingPermits, 'permit'],
  [PENDING_UNDER_GRANT, pendingUnderGrant, 'refused-under-grant'],
]) {
  if (rows.length === 0) continue;

  rmSync(file, { force: true });
  console.log(`merged ${rows.length} pending ${label} record(s) and removed the pending file.`);
}
