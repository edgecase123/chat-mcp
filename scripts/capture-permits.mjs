#!/usr/bin/env node
/**
 * Record what a grant actually DOES, which is the half the corpus lacks.
 *
 * 🛑 A REFUSAL IS FREE AND A PERMIT IS NOT. A refusal is filed the moment the
 * child is denied. A permit needs the approval answered and the agent given
 * another turn, and until now the only way to answer one was a browser click.
 * `answerAndNotify` made it scriptable.
 *
 * 🛑 THIS DOES NOT MAKE THE PRODUCT AUTO-APPROVE. lee's ruling stands: manual
 * is the default permission mode. This harness supplies its own decision
 * because it is recording an OUTCOME, not testing the approval surface —
 * `supervise-e2e.mjs` is what proves a human can approve, and it still needs
 * a real click.
 *
 * ⚠️ IT SPENDS MONEY. Opt in with CHAT_MCP_LIVE=1.
 *
 *   CHAT_MCP_LIVE=1 node --import tsx scripts/capture-permits.mjs
 *
 * 🛑 ONE PROBE PER SUPERVISOR, ON PURPOSE. Running them together lets one
 * probe's grant widen the allowlist the next one is measured under, and a
 * two-variable run is how three wrong conclusions were drawn in one evening.
 */

import { mkdtempSync, rmSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSupervisor } from '../src/supervise/index.ts';
import { deliverToSupervisor } from '../src/supervise/socket.ts';
import { answerAndNotify } from '../src/supervise/answer.ts';
import { openDb } from '../src/storage/db.ts';
import * as dao from '../src/storage/dao.ts';

if (!process.env.CHAT_MCP_LIVE) {
  console.error('Refusing to run: this spawns a real agent CLI and spends money.');
  console.error('Set CHAT_MCP_LIVE=1 to opt in.');
  process.exit(2);
}

const BASE_ALLOWLIST = ['Read', 'Glob', 'Grep', 'mcp__chat__send', 'mcp__chat__room_send'];
const SETTLE_MS = Number(process.env.PERMIT_SETTLE_SECONDS ?? 90) * 1000;
const db = openDb();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Every probe needs an OBSERVABLE target.
 *
 * 🛑 ASKING THE AGENT WHETHER IT WORKED ASKS THE THING UNDER TEST. `env` was
 * in the refusal harness and is useless here: it changes nothing anyone can
 * look at afterwards.
 */
function probesFor(root, work, handle) {
  const made = join(work, 'made.txt');
  const tag = `permit-${process.pid}`;
  const sentinel = `permit-ok-${process.pid}`;

  return [
    {
      /**
       * 🛑 THE PROBE THAT CHECKS A CLAIM I MADE AND BUILT ON. After run 8 I
       * concluded `rm` cannot be granted by any allowlist entry, and the e2e
       * task was changed away from the filesystem because of it. Run 8
       * predates BOTH the path-spelling fix (6cca826) and the prose fix
       * (468f5dc), so the grant it was refused under was malformed.
       *
       * `touch` was measured as grantable here, which already contradicts
       * the general form of that claim.
       */
      label: 'remove a file inside the allowed directory',
      command: `rm ${join(work, 'README.md')}`,
      moved: () => !existsSync(join(work, 'README.md')),
    },
    {
      label: 'touch a file inside the allowed directory',
      command: `touch ${made}`,
      moved: () => existsSync(made),
    },
    {
      label: 'create a git tag in the scratch repo',
      command: `git -C ${work} tag ${tag}`,
      moved: () => {
        try {
          return execFileSync('git', ['-C', work, 'tag', '-l', tag]).toString().includes(tag);
        } catch {
          return false;
        }
      },
    },
    {
      label: 'publish a status over MCP',
      command: `mcp__chat__set_status with status "tool" and focus exactly "${sentinel}"`,
      moved: () => {
        const a = dao.getAgent(db, `${handle}-agent`);

        return `${a?.focus ?? ''} ${a?.status ?? ''}`.includes(sentinel);
      },
    },
  ];
}

const captured = [];
const PROBE_LABELS = probesFor('', '', 'x').map((p) => p.label);

for (const index of [0, 1, 2, 3]) {
  const handle = `perm-${process.pid}-${index}`;
  const root = mkdtempSync(join(tmpdir(), 'chat-mcp-e2e-'));
  const work = join(root, 'work');
  mkdirSync(work);
  writeFileSync(join(work, 'README.md'), 'permit\n', 'utf8');
  execFileSync('git', ['init', '-q', '-b', 'main', work]);
  execFileSync('git', ['-C', work, 'config', 'user.email', 'p@example.com']);
  execFileSync('git', ['-C', work, 'config', 'user.name', 'p']);
  execFileSync('git', ['-C', work, 'add', '-A']);
  execFileSync('git', ['-C', work, 'commit', '-q', '-m', 'initial']);

  const probe = probesFor(root, work, handle)[index];

  console.log(`\n── probe ${index + 1}: ${probe.label}`);
  console.log(`   ${probe.command}`);

  const sup = await startSupervisor({
    handle,
    extraDirs: [root],
    allowedTools: BASE_ALLOWLIST,
    log: () => undefined,
  });

  try {
    await deliverToSupervisor(handle, {
      id: 1,
      to: handle,
      from: 'permit-harness',
      ts: Date.now(),
      body:
        `Attempt exactly this, once, as a single tool call: ${probe.command}\n` +
        `Do NOT rephrase it, do NOT substitute anything, and do NOT work around a block. ` +
        `If you are blocked, say so and stop.`,
    });

    const answered = new Set();
    const deadline = Date.now() + SETTLE_MS;
    let grantedAllowlist = null;

    while (Date.now() < deadline && !probe.moved()) {
      await sleep(2000);

      for (const row of dao.pendingApprovals(db, `${handle}-agent`)) {
        if (answered.has(row.id)) continue;
        answered.add(row.id);

        const outcome = answerAndNotify(db, row.id, 'approve', 'permit-harness');

        console.log(`   approval ${row.id}: ${outcome.kind}  grant=${row.grant ?? '(none)'}`);

        if (outcome.kind === 'answered' && row.grant) grantedAllowlist = [...BASE_ALLOWLIST, row.grant];
      }
    }

    const worked = probe.moved();

    console.log(`   target moved: ${worked}`);

    if (worked && grantedAllowlist) {
      captured.push({
        outcome: 'permitted',
        probe: probe.label,
        approvalId: [...answered].pop() ?? null,
        attempted: probe.command,
        allowlistEntry: grantedAllowlist[grantedAllowlist.length - 1],
        evidence:
          `${new Date().toISOString().slice(0, 10)}: ${probe.label} — the target moved after ` +
          `the grant was added. HISTORICAL: the scratch directory is deleted when this run ends.`,
      });
    }
  } finally {
    await sup.stop();
    rmSync(root, { recursive: true, force: true });
  }
}

// 🛑 ONE RESULT PER PROBE, NAMED. `captured.length > 0` exits 0 on 1 of 4,
// which certifies a run that mostly failed. claude1 on PR 43.
const missing = PROBE_LABELS.filter((l) => !captured.some((c) => c.probe === l));

console.log(`\n${captured.length} of ${PROBE_LABELS.length} probe(s) produced a permit, 0 clicks needed.`);

for (const m of missing) console.log(`  NO PERMIT: ${m}`);

for (const c of captured) console.log(`  ${c.allowlistEntry}`);

// 🛑 WRITTEN BESIDE THE FIXTURE, NOT INTO IT. Merging is `rebuild-corpus.mjs`
// work, and a harness that edits the fixture directly is how an inline
// rebuild silently discarded a record earlier today.
writeFileSync('test/fixtures/captured-permits.pending.json', `${JSON.stringify(captured, null, 2)}\n`);
console.log('\nwrote test/fixtures/captured-permits.pending.json');

process.exit(missing.length === 0 ? 0 : 1);
