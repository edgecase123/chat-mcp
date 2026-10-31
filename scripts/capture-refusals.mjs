#!/usr/bin/env node
/**
 * Grow the refusal corpus WITHOUT costing a human a single click.
 *
 * 🛑 A REFUSAL IS FILED WHEN THE CHILD IS DENIED, BEFORE ANY HUMAN IS
 * INVOLVED. Only a PERMIT needs someone to click Approve. So the expensive
 * half of the corpus is the permits, and the refusals are nearly free — one
 * agent turn yields one record per operation it attempts.
 *
 * ⚠️ IT STILL SPENDS MONEY. It spawns a real agent CLI. Opt in with
 * CHAT_MCP_LIVE=1.
 *
 *   CHAT_MCP_LIVE=1 node --import tsx scripts/capture-refusals.mjs
 *
 * It answers nothing and approves nothing. Afterwards, rebuild the fixture
 * from the database and the new rows are picked up.
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSupervisor } from '../src/supervise/index.ts';
import { deliverToSupervisor } from '../src/supervise/socket.ts';
import { openDb } from '../src/storage/db.ts';
import * as dao from '../src/storage/dao.ts';

if (!process.env.CHAT_MCP_LIVE) {
  console.error('Refusing to run: this spawns a real agent CLI and spends money.');
  console.error('Set CHAT_MCP_LIVE=1 to opt in.');
  process.exit(2);
}

const HANDLE = `cap-${process.pid}`;
const WAIT_MS = Number(process.env.CAPTURE_WAIT_SECONDS ?? 180) * 1000;

const root = mkdtempSync(join(tmpdir(), 'chat-mcp-e2e-'));
const work = join(root, 'work');
mkdirSync(work);
writeFileSync(join(work, 'README.md'), 'capture\n', 'utf8');

/**
 * One line per gate class we know of, so a single turn samples all of them.
 *
 * 🛑 THE AGENT MUST NOT WORK AROUND A BLOCK. Every previous run that let it
 * improvise produced reconnaissance commands instead of the operation under
 * test, and those are the records that taught us least.
 */
const OPERATIONS = [
  `rm ${join(work, 'README.md')}`,
  `touch ${join(work, 'made.txt')}`,
  `cd ${work} && git status`,
  `env | head -3`,
  `mcp__chat__set_status with focus "capture probe"`,
];

const db = openDb();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const filed = () => dao.pendingApprovals(db, `${HANDLE}-agent`);

console.log(`handle=${HANDLE}  workdir=${work}`);
console.log(`attempting ${OPERATIONS.length} operations; NO approval is needed\n`);

const sup = await startSupervisor({
  handle: HANDLE,
  extraDirs: [root],
  allowedTools: ['Read', 'Glob', 'Grep', 'mcp__chat__send', 'mcp__chat__room_send'],
  log: (line) => console.log(`    ${line}`),
});

try {
  await deliverToSupervisor(HANDLE, {
    id: 1,
    to: HANDLE,
    from: 'capture-harness',
    ts: Date.now(),
    body:
      `Attempt each of these in order, exactly as written, one tool call each. ` +
      `Expect most to be blocked — that is the point, so do NOT work around a block, ` +
      `do NOT rephrase, and do NOT substitute a different command. ` +
      `Report what each one returned.\n\n` +
      OPERATIONS.map((o, i) => `${i + 1}. ${o}`).join('\n'),
  });

  // 🛑 WAIT ON THE ROW COUNT SETTLING, not on a fixed sleep. The agent files
  // a row per denial and there is no event for "it has stopped trying".
  let seen = 0;
  let quiet = 0;
  const deadline = Date.now() + WAIT_MS;

  while (Date.now() < deadline && quiet < 6) {
    await sleep(2000);
    const now = filed().length;
    quiet = now === seen ? quiet + 1 : 0;
    if (now !== seen) console.log(`    captured ${now} refusal(s) so far`);
    seen = now;
  }

  const rows = filed();

  console.log(`\n${rows.length} refusal(s) captured, 0 clicks needed:\n`);

  for (const r of rows) {
    const allowlist = r.allowlist === null ? 'NULL — NOT RECORDED' : `${r.allowlist.length} entries`;
    console.log(`  approval ${r.id}  allowlist: ${allowlist}`);
    console.log(`    grant   : ${r.grant ?? '(none — cannot be approved)'}`);
  }

  const unrecorded = rows.filter((r) => r.allowlist === null).length;

  if (unrecorded > 0) {
    console.error(`\n${unrecorded} row(s) recorded NO allowlist, which makes them silent.`);
  }

  process.exit(rows.length > 0 && unrecorded === 0 ? 0 : 1);
} finally {
  await sup.stop();
  rmSync(root, { recursive: true, force: true });
}
