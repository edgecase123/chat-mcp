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

import { writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/storage/db.ts';
import { normalise } from '../test/support/would-refuse.ts';

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

// 🛑 PERMITS ARE CARRIED OVER, NOT DERIVED. A success is not in the approvals
// table — the proof is an observed side effect, and the existing record states
// its evidence and that the evidence is historical.
const permits = JSON.parse(readFileSync(FIXTURE, 'utf8')).filter((r) => r.outcome === 'permitted');

writeFileSync(FIXTURE, `${JSON.stringify([...refused, ...permits], null, 2)}\n`);

const recorded = refused.filter((r) => r.allowlist !== null);

console.log(`wrote ${refused.length + permits.length} records`);
console.log(`  refusals with a recorded allowlist : ${recorded.length}`);
console.log(`  measured permits                   : ${permits.length}`);
console.log(`  records present but SILENT         : ${refused.length - recorded.length}`);
console.log(`\nreal coverage is ${recorded.length + permits.length}, not ${refused.length + permits.length}.`);
