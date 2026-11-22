#!/usr/bin/env node
/**
 * #380 SLICE 4, REQUIREMENT 2: does `--resume` actually work in a container?
 *
 * `cursor-container-acceptance.mjs` proves ONE turn completes. This proves the
 * SECOND turn reaches the same `cursor-agent` session, which is the only thing
 * that shows the session store survives inside the container.
 *
 * ⚠️ IT SPENDS REAL MONEY and needs docker. Opt in with CHAT_MCP_LIVE=1.
 *
 * 🛑 THE NONCE NEVER APPEARS IN TURN TWO'S PROMPT. A fresh session cannot
 * produce it, so recall is the proof. The script asserts that absence rather
 * than trusting it, because a leaked nonce would make the whole run vacuous.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSupervisor } from "../src/supervise/index.ts";
import { deliverToSupervisor } from "../src/supervise/socket.ts";
import { openDb } from "../src/storage/db.ts";
import * as dao from "../src/storage/dao.ts";
import { cursorSpawn } from "../src/adapters/cursor-spawn.ts";
import { markConfirmed } from "../src/supervise/container.ts";
import { buildConfirmPlan } from "../src/supervise/confirmPlan.ts";
import { ensureFreshVendorImage } from "./lib/fresh-image.mjs";

if (!process.env.CHAT_MCP_LIVE) {
  console.error("Refusing: spawns a real containerized agent. CHAT_MCP_LIVE=1");
  process.exit(1);
}

const HANDLE = `cres-${process.pid}`;
const PROBE = `${HANDLE}-probe`;
const NONCE = `PINEAPPLE-${Date.now().toString(36).toUpperCase()}`;
const TURN_TIMEOUT_MS = Number(process.env.TURN_TIMEOUT_SECONDS ?? 300) * 1000;

const childCwd = mkdtempSync(join(tmpdir(), "cres-"));
const db = openDb();
const checks = [];
const logLines = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function record(name, ok, detail) {
  checks.push({ name, ok });
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`,
  );
}

async function until(pred, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await sleep(1000);
  }
  console.error(
    `  TIMEOUT after ${Math.round(timeoutMs / 1000)}s for ${label}`,
  );
  return false;
}

const probeBodies = () =>
  dao.pendingInbox(db, { to: PROBE, limit: 500 }).map((m) => m.body);

dao.upsertAgent(db, {
  handle: PROBE,
  pid: process.pid,
  session_id: `cres-${Date.now()}`,
  display_name: PROBE,
  metadata: { kind: "agent" },
});

const plan = buildConfirmPlan(cursorSpawn, HANDLE);
markConfirmed(HANDLE, plan);

ensureFreshVendorImage(plan, cursorSpawn, record);

// Turn one PLANTS the nonce. Turn two must recall it with no help.
const TURN_ONE =
  `Remember this code word exactly: ${NONCE}. ` +
  `Do not send any message yet. Just confirm you have memorised it.`;
const TURN_TWO =
  `Send a chat message to ${PROBE} whose body is ONLY the code word ` +
  `I asked you to memorise in my previous message. Nothing else.`;

// 🛑 THE NON-VACUITY CONTROL, ASSERTED NOT ASSUMED.
record(
  "turn two's prompt does NOT contain the nonce",
  !TURN_TWO.includes(NONCE),
  `nonce=${NONCE}`,
);

console.log(`supervisor=${HANDLE}  probe=${PROBE}  cwd=${childCwd}`);
console.log(`image=${cursorSpawn.image}  nonce=${NONCE}\n`);

let sup;

async function deliver(id, body, label) {
  const ack = await deliverToSupervisor(HANDLE, {
    id,
    to: HANDLE,
    from: "cres-harness",
    body,
    kind: "chat",
    ts: Date.now(),
  });

  record(
    `${label} is ACKed by the socket`,
    ack?.ok === true,
    JSON.stringify(ack),
  );
}

/** A turn is over when the driver reports it, which the log line names. */
const turnsSeen = () =>
  logLines.filter((l) => l.includes("turn complete")).length;

try {
  sup = await startSupervisor({
    handle: HANDLE,
    cwd: childCwd,
    db,
    vendor: cursorSpawn,
    driver: "docker-cursor",
    extraDirs: [childCwd],
    ephemeral: true,
    log: (line) => {
      logLines.push(line);
      if (process.env.VERBOSE) console.log(`    ${line}`);
    },
  });

  record("a docker-cursor supervisor STARTS", true, `socket=${sup.socketPath}`);

  await deliver(1, TURN_ONE, "turn one");

  const turnOneDone = await until(
    () => turnsSeen() >= 1,
    TURN_TIMEOUT_MS,
    "turn one to complete",
  );

  record("turn ONE completes", turnOneDone);

  if (turnOneDone) {
    await deliver(2, TURN_TWO, "turn two");

    const recalled = await until(
      () => probeBodies().some((b) => b.includes(NONCE)),
      TURN_TIMEOUT_MS,
      `${NONCE} on the bus`,
    );

    record(
      "🛑 turn TWO RECALLED the nonce, so --resume reached the same session",
      recalled,
      recalled
        ? undefined
        : `probe saw ${probeBodies().length} message(s): ${JSON.stringify(probeBodies().slice(-3))}`,
    );
  }
} catch (err) {
  record(
    "the run completes without throwing",
    false,
    String(err?.message ?? err),
  );
} finally {
  await sup?.stop().catch(() => undefined);
}

const failed = checks.filter((c) => !c.ok);

console.log(
  `\n${checks.length - failed.length}/${checks.length} checks passed`,
);

if (failed.length && !process.env.VERBOSE) {
  console.log("\n--- supervisor log ---");
  for (const l of logLines.slice(-40)) console.log(l);
}

process.exit(failed.length ? 1 : 0);
