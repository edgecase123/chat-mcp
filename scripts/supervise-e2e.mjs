#!/usr/bin/env node
/**
 * The END-TO-END run: a real agent, blocked, approved by a human, carrying on.
 *
 * 🛑 THIS IS THE ONLY THING THAT PROVES THE FEATURE. Every link has a unit
 * guard and claude1 found FOUR separate cases where guarded links did not
 * join up — a callback registered outside the function that re-registers it,
 * a grant that never reached the child, a detector imported and never called,
 * a prompt template registered and never read. Each time the suite was green.
 *
 * ⚠️ IT SPENDS REAL MONEY and needs a HUMAN to click Approve. Opt in with
 * CHAT_MCP_LIVE=1.
 *
 *   CHAT_MCP_LIVE=1 node --import tsx scripts/supervise-e2e.mjs
 *
 * What it does, and what each step proves:
 *
 *   1  spawn a supervised agent in a scratch directory
 *   2  ask it to run a command the allowlist does NOT permit
 *   3  the denial becomes a PENDING APPROVAL        <- producer wired
 *   4  a human clicks Approve in `chat-mcp web`     <- the UI is reachable
 *   5  the supervisor replaces the child, resuming  <- replaceChild works
 *   6  the command finally runs                     <- the grant REACHED it
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
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

const HANDLE = `e2e-${process.pid}`;

/**
 * 🛑 THE TASK MUST BE DENIABLE AND THEN GRANTABLE. `rm` is the first of
 * those and not the second.
 *
 * 🚨 `rm` CANNOT BE GRANTED BY THE ALLOWLIST AT ALL — measured on run 8.
 * Approval 14 granted `Bash(rm <path>)`; approval 16 asked for that exact
 * string, bare, and was refused anyway with *"Claude Code may only remove
 * files from the allowed working directories"* — naming a directory the
 * path was already inside. A separate rule governs `rm` and no
 * `--allowedTools` entry reaches it, so the old task looped forever.
 *
 * `touch` is deniable for the ordinary reason — Bash exists as a built-in
 * but is not allowlisted here — and carries no rule of its own.
 */
const MODE = process.env.E2E_MODE ?? 'nameable';
const WAIT_MS = Number(process.env.APPROVAL_WAIT_SECONDS ?? 300) * 1000;

/**
 * A scratch GIT repository, registered as this agent's project.
 *
 * 🛑 THE TASK HAS TO NEED A TOOL THE ALLOWLIST DOES NOT NAME, and the first
 * version of this script got that wrong. It asked the agent to delete a file
 * inside its own scope — but `Edit(<glob>)` rules govern every file-editing
 * tool, so the agent simply did it and no approval was ever needed. The run
 * proved containment and proved nothing about the relay.
 *
 * `git push` is the honest choice: it is on lee's excluded list by name and
 * no scope reaches it. The remote is a bare repo on disk, so a successful
 * push changes nothing outside this directory.
 */
const root = mkdtempSync(join(tmpdir(), 'chat-mcp-e2e-'));
const workdir = join(root, 'work');
const remote = join(root, 'remote.git');

/**
 * The sentinel the agent must publish with `set_status`.
 *
 * 🛑 NOT A FILE. `rm` and `touch` BOTH proved that Claude Code refuses a
 * filesystem mutation by a rule no `--allowedTools` entry overrides — and
 * both refusals named a directory the target already sat inside. Runs 8
 * and 11.
 *
 * `set_status` is denied for the ordinary reason, that this allowlist does
 * not name it, and its effect lands in a row anyone can read.
 */
const SENTINEL = `e2e-ok-${process.pid}`;

const git = (args, cwd) => execFileSync('git', args, { cwd, stdio: 'pipe' });

execFileSync('git', ['init', '--bare', '-q', remote]);
execFileSync('git', ['init', '-q', '-b', 'main', workdir]);
git(['config', 'user.email', 'e2e@example.com'], workdir);
git(['config', 'user.name', 'e2e'], workdir);
writeFileSync(join(workdir, 'README.md'), 'e2e\n', 'utf8');
git(['add', '-A'], workdir);
git(['commit', '-q', '-m', 'initial'], workdir);
git(['remote', 'add', 'origin', remote], workdir);

/** Did the push land? The bare remote is the only honest answer. */
const pushed = () => {
  try {
    return execFileSync('git', ['log', '--oneline', '-1', 'main'], { cwd: remote })
      .toString()
      .includes('initial');
  } catch {
    return false;
  }
};

const db = openDb();

/**
 * Did the status land? The agents row is the only honest answer.
 *
 * Either field counts: the point is that the tool CALL reached the server,
 * not which argument the agent chose to carry the sentinel.
 */
const published = () => {
  const agent = dao.getAgent(db, `${HANDLE}-agent`);

  return `${agent?.focus ?? ''} ${agent?.status ?? ''}`.includes(SENTINEL);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(pred, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (pred()) return true;
    await sleep(1000);
  }

  console.error(`  TIMEOUT after ${Math.round(timeoutMs / 1000)}s waiting for ${label}`);

  return false;
}

const checks = [];
const record = (name, ok, detail) => {
  checks.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const pending = () => dao.pendingApprovals(db, `${HANDLE}-agent`);

console.log(`handle=${HANDLE}  workdir=${workdir}`);
console.log(`remote=${remote}\n`);

const sup = await startSupervisor({
  handle: HANDLE,
  extraDirs: [root],
  // No Edit scope: the target is REACHABLE but no rule covers editing it,
  // which is what makes `rm` name itself in the refusal.
  allowedTools:
    MODE === 'nameable'
      ? ['Read', 'Glob', 'Grep', 'mcp__chat__send', 'mcp__chat__room_send']
      : undefined,
  log: (line) => console.log(`    ${line}`),
});

try {
  // ── 1. Ask for something the allowlist does not permit ─────────────────
  const ack = await deliverToSupervisor(HANDLE, {
    id: 1,
    to: HANDLE,
    from: 'e2e-harness',
    ts: Date.now(),
    body:
      MODE === 'nameable'
        ? `Please call set_status with focus set to exactly "${SENTINEL}". ` +
          `If you are blocked, say so and stop — do not work around it.`
        : `Please run \`git push -u origin main\` in ${workdir}. ` +
          `If you are blocked, say so and stop — do not work around it.`,
  });

  record('the socket ACKs the delivery', ack?.ok === true, JSON.stringify(ack));

  // ── 2. The denial must become a pending approval ───────────────────────
  const asked = await until(() => pending().length > 0, 180_000, 'a pending approval');
  record('the denial becomes a PENDING APPROVAL a human can see', asked);

  if (!asked) throw new Error('no approval was ever filed; the producer is broken');

  const request = pending()[0];

  // 🛑 THIS SCRIPT AND THE FIX USED TO CONTRADICT EACH OTHER. It asks for
  // `git push`, the one case measured as UNNAMEABLE, and the first fix filed
  // nothing for those — so the script would have failed while the producer
  // worked exactly as designed. Found by claude1 reviewing PR 41.
  //
  // The row is filed now, so the card always appears. An unnamed one can
  // only be DENIED, and the run says so rather than waiting for an Approve
  // that is not offered.
  console.log(
    `\n  🛑 APPROVAL ${request.id} IS WAITING: ${request.requested ?? '(the CLI named no command — Deny only)'}`,
  );
  console.log('  Open `chat-mcp web` and click Approve, or run:');
  console.log(
    `    curl -s -X POST http://127.0.0.1:<port>/api/approvals/answer ` +
      `-H 'Content-Type: application/json' -d '{"id":${request.id},"decision":"approve"}'\n`,
  );

  // ── 3. A HUMAN answers. Nothing here answers for them. ─────────────────
  const answered = await until(
    () => dao.getApproval(db, request.id)?.decision != null,
    WAIT_MS,
    'a human to answer',
  );
  record('a human answered the request', answered);

  if (!answered) throw new Error('nobody answered; the run proves nothing past this point');

  const decision = dao.getApproval(db, request.id)?.decision;
  console.log(`  decision: ${decision}\n`);

  // The check differs by mode, and the TARGET is the only honest answer in
  // both: asking the agent whether it succeeded asks the thing under test.
  const succeeded = MODE === 'nameable' ? published : pushed;

  // 🛑 `grant`, NOT `requested`. `answerApproval` throws only when there is
  // nothing to allowlist, and run 8 approved a card whose prose was null.
  if (request.grant == null) {
    record('an UNGRANTABLE request offers Deny only, and nothing happened', !succeeded());
  } else if (decision !== 'approve') {
    record('nothing happened after a DENY', !succeeded());
  } else {
    // ── 4. The grant must REACH the child, which is the bug that shipped ──
    const done = await until(succeeded, 180_000, 'the approved command to run');

    record('the approved command actually RAN', done, done ? 'the target moved' : 'the target never moved');
  }
} finally {
  await sup.stop();
  rmSync(root, { recursive: true, force: true });
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);

for (const f of failed) console.log(`  FAILED: ${f.name}`);

// 🛑 The exit code is the verdict. A log tail is only the transcript.
process.exit(failed.length === 0 ? 0 : 1);
