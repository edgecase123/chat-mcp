#!/usr/bin/env node
/**
 * The LIVE viability harness for the supervisor (chat-mcp#33).
 *
 * 🛑 THIS EXISTS BECAUSE THE VIABILITY PROOF WAS NOT RERUNNABLE. Every claim
 * on #33 came from an ad-hoc spike that was never committed, so nobody —
 * including its author — could re-verify it. The numbers were prose.
 *
 * 🛑 AND BECAUSE THE CORE CLAIM WAS NEVER TESTED AT ALL. Every logged spike
 * run produced exactly ONE `result` event. "A long-lived child handles turn 2"
 * was assumed. No test spawns a real child: every supervisor test injects
 * `spawnChild: () => fake`.
 *
 * ⚠️ IT SPENDS REAL MONEY. One cold turn measured $0.18 at the floor. Opt in
 * with CHAT_MCP_LIVE=1 so it can never run from `npm test`.
 *
 *   CHAT_MCP_LIVE=1 node --import tsx scripts/supervise-live.mjs
 *   CHAT_MCP_LIVE=1 IDLE_GAP_SECONDS=1800 node --import tsx scripts/supervise-live.mjs
 *
 * Three handles, and they must all differ:
 *
 *   live-<pid>         the supervisor. Owns the socket.
 *   live-<pid>-agent   the child. Registers via the generated private config.
 *   live-<pid>-probe   where the child replies. NOBODY supervises it, so a
 *                      reply cannot wake the child that sent it.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSupervisor } from '../src/supervise/index.ts';
import { spawnClaude } from '../src/supervise/child.ts';
import { childHandleFor } from '../src/supervise/bus-reply.ts';
import { deliverToSupervisor } from '../src/supervise/socket.ts';
import { openDb } from '../src/storage/db.ts';
import * as dao from '../src/storage/dao.ts';

if (!process.env.CHAT_MCP_LIVE) {
  console.error('Refusing to run: this spawns a real agent CLI and spends money.');
  console.error('Set CHAT_MCP_LIVE=1 to opt in.');
  process.exit(2);
}

const HANDLE = `live-${process.pid}`;
const PROBE = `${HANDLE}-probe`;
const CHILD = childHandleFor(HANDLE);
const IDLE_GAP_MS = Number(process.env.IDLE_GAP_SECONDS ?? 90) * 1000;
const TURN_TIMEOUT_MS = Number(process.env.TURN_TIMEOUT_SECONDS ?? 180) * 1000;

/**
 * An EMPTY cwd, deliberately.
 *
 * ⚠️ #33 compared a bare dir at $0.18 against a repo with a 36KB CLAUDE.md at
 * $0.75 and called it a context measurement. It was not — the second run also
 * attempted tool calls and then reasoned about being denied. An empty dir
 * keeps this harness measuring the supervisor rather than somebody's repo.
 */
const childCwd = mkdtempSync(join(tmpdir(), 'chat-mcp-live-'));

const db = openDb();
const events = [];
const logLines = [];

/** Every `result` event is one completed turn. Nothing else ends a turn. */
const results = () => events.filter((e) => e.type === 'result');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait until `pred` holds, or give up. Returns true on success. */
async function until(pred, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (pred()) return true;
    await sleep(500);
  }

  console.error(`  TIMEOUT after ${Math.round(timeoutMs / 1000)}s waiting for ${label}`);

  return false;
}

/** Everything the child has said to the probe handle so far. */
function probeBodies() {
  return dao.pendingInbox(db, { to: PROBE, limit: 500 }).map((m) => m.body);
}

function prompt(token) {
  return [
    `This is an automated liveness probe. Do exactly one thing and nothing else.`,
    `Call mcp__chat__send with to="${PROBE}" and body="${token}".`,
    `Send the body EXACTLY as given, with no extra words.`,
  ].join(' ');
}

const checks = [];

function record(name, ok, detail) {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

/** Deliver over the SOCKET, which is the path a real sender takes. */
async function deliver(id, token) {
  const ack = await deliverToSupervisor(HANDLE, {
    id,
    to: HANDLE,
    from: 'live-harness',
    body: prompt(token),
    kind: 'chat',
    ts: Date.now(),
  });

  return ack;
}

async function awaitToken(token, expectedTurns) {
  const ok = await until(
    () => probeBodies().some((b) => b.includes(token)) && results().length >= expectedTurns,
    TURN_TIMEOUT_MS,
    `${token} and ${expectedTurns} result event(s)`,
  );

  return ok;
}

console.log(`supervisor=${HANDLE}  child=${CHILD}  probe=${PROBE}`);
console.log(`cwd=${childCwd}  idle gap=${IDLE_GAP_MS / 1000}s\n`);

const sup = await startSupervisor({
  handle: HANDLE,
  cwd: childCwd,
  // Tap the raw stream so turn COUNT is observed, not inferred from a reply.
  spawnChild: (opts) => {
    const child = spawnClaude(opts);
    child.onEvent((e) => events.push(e));

    return child;
  },
  log: (line) => {
    logLines.push(line);
    if (process.env.VERBOSE) console.log(`    ${line}`);
  },
});

try {
  // ── 1. One message wakes an idle agent and it answers ──────────────────
  const ack1 = await deliver(1, 'TOKEN-1');
  record('the socket ACKs the delivery', ack1?.ok === true, JSON.stringify(ack1));
  record('turn 1 completes and the child answers on the bus', await awaitToken('TOKEN-1', 1));

  // ── 2. THE CORE UNPROVEN CLAIM: turn 2 on the SAME child ───────────────
  await deliver(2, 'TOKEN-2');
  const twoTurns = await awaitToken('TOKEN-2', 2);
  record('turn 2 completes on the SAME long-lived child', twoTurns, `${results().length} result events`);

  // ── 3. Two deliveries mid-flight must not merge into one turn ──────────
  // Measured on #33: two user messages written at once produced ONE result
  // and the first question went unanswered. That is what the queue exists to
  // prevent, and it has only ever been tested against a fake child.
  await deliver(3, 'TOKEN-3');
  await deliver(4, 'TOKEN-4');

  const bothAnswered = await until(
    () => {
      const bodies = probeBodies();
      return (
        bodies.some((b) => b.includes('TOKEN-3')) &&
        bodies.some((b) => b.includes('TOKEN-4')) &&
        results().length >= 4
      );
    },
    TURN_TIMEOUT_MS * 2,
    'TOKEN-3 and TOKEN-4 and 4 result events',
  );
  record('two messages arriving together produce TWO turns, not one', bothAnswered,
    `${results().length} result events`);

  // ── 4. The child survives being idle ──────────────────────────────────
  console.log(`\n  idling ${IDLE_GAP_MS / 1000}s ...`);
  await sleep(IDLE_GAP_MS);

  await deliver(5, 'TOKEN-5');
  record(
    `turn 5 completes after a ${IDLE_GAP_MS / 1000}s idle gap`,
    await awaitToken('TOKEN-5', 5),
  );

  // ── 5. What a turn COSTS, per turn, so growth is visible ───────────────
  console.log('\nper-turn usage, from each result event:');
  console.log('turn  input   cache_read  cache_creation  output  cost_usd');

  results().forEach((r, i) => {
    const u = r.usage ?? {};
    const row = [
      String(i + 1).padEnd(4),
      String(u.input_tokens ?? '?').padEnd(7),
      String(u.cache_read_input_tokens ?? '?').padEnd(11),
      String(u.cache_creation_input_tokens ?? '?').padEnd(15),
      String(u.output_tokens ?? '?').padEnd(7),
      String(r.total_cost_usd ?? '?'),
    ];
    console.log(row.join(' '));
  });

  const costs = results().map((r) => r.total_cost_usd).filter((c) => typeof c === 'number');
  if (costs.length > 0) {
    console.log(`\ntotal cost reported: $${costs.reduce((a, b) => a + b, 0).toFixed(4)}`);
  }

  // ── 6. A reply must not have woken the child that sent it ─────────────
  // The probe handle is unsupervised on purpose. If turn count exceeds the
  // number of messages delivered, a reply fed itself back in.
  record(
    'no feedback loop: turns never exceeded deliveries',
    results().length <= 5,
    `5 delivered, ${results().length} turns`,
  );
} finally {
  await sup.stop();
  rmSync(childCwd, { recursive: true, force: true });
}

const failed = checks.filter((c) => !c.ok);

console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);

if (failed.length > 0) {
  console.log('\nFAILED:');
  for (const f of failed) console.log(`  - ${f.name}`);
}

// 🛑 The exit code is the verdict. A log tail is only the transcript.
process.exit(failed.length === 0 ? 0 : 1);
