#!/usr/bin/env node
/**
 * #317's LIVE CONTAINERIZED ACCEPTANCE CHECK.
 *
 * Spawn a real `cursor-agent` inside its own container, have it call a bus
 * tool, and assert the message arrived. The ticket asks for this as an
 * acceptance check and explicitly NOT as a suite test.
 *
 * ⚠️ IT SPENDS REAL MONEY and needs docker. Opt in with CHAT_MCP_LIVE=1.
 *
 * 🛑 IT CONFIRMS THE CONTAINER GATE PROGRAMMATICALLY via `markConfirmed`.
 * The interactive prompt needs a TTY and this runs without one, so the
 * operator-facing confirm flow is NOT exercised here. That is #132 open
 * question 1 and it is deliberately out of scope.
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
import { readVendorToken } from "../src/supervise/auth.ts";

if (!process.env.CHAT_MCP_LIVE) {
  console.error("Refusing: spawns a real containerized agent. CHAT_MCP_LIVE=1");
  process.exit(1);
}

const HANDLE = `cacc-${process.pid}`;
const PROBE = `${HANDLE}-probe`;
const TOKEN = `CURSOR-ACCEPT-${Date.now()}`;
const TURN_TIMEOUT_MS = Number(process.env.TURN_TIMEOUT_SECONDS ?? 240) * 1000;

const childCwd = mkdtempSync(join(tmpdir(), "cacc-"));
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
    `  TIMEOUT after ${Math.round(timeoutMs / 1000)}s waiting for ${label}`,
  );
  return false;
}

const probeBodies = () =>
  dao.pendingInbox(db, { to: PROBE, limit: 500 }).map((m) => m.body);

// The child's send is REFUSED unless the recipient is a registered peer.
dao.upsertAgent(db, {
  handle: PROBE,
  pid: process.pid,
  session_id: `cacc-${Date.now()}`,
  display_name: PROBE,
  metadata: { kind: "agent" },
});

record(
  "a real CURSOR_API_KEY is on file",
  Boolean(readVendorToken(cursorSpawn)),
);

// Satisfy the container gate the way the operator's confirm would.
markConfirmed(HANDLE, buildConfirmPlan(cursorSpawn, HANDLE));

console.log(`supervisor=${HANDLE}  probe=${PROBE}  cwd=${childCwd}`);
console.log(`image=${cursorSpawn.image}  token=${TOKEN}\n`);

let sup;

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

  const ack = await deliverToSupervisor(HANDLE, {
    id: 1,
    to: HANDLE,
    from: "cacc-harness",
    body: `Please send a chat message to ${PROBE} with the body "${TOKEN}". Thanks.`,
    kind: "chat",
    ts: Date.now(),
  });

  record("the socket ACKs the delivery", ack?.ok === true, JSON.stringify(ack));

  const arrived = await until(
    () => probeBodies().some((b) => b.includes(TOKEN)),
    TURN_TIMEOUT_MS,
    `${TOKEN} on the bus`,
  );

  record(
    "🛑 the CONTAINERIZED Cursor agent called a bus tool and the message ARRIVED",
    arrived,
    arrived ? undefined : `probe saw ${probeBodies().length} message(s)`,
  );
} catch (err) {
  record(
    "a docker-cursor supervisor STARTS",
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
