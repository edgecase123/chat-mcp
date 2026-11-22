#!/usr/bin/env node
/**
 * #348's LIVE HOST ACCEPTANCE CHECK.
 *
 * Spawn a real `cursor-agent` as a bare HOST process, have it call a bus tool,
 * and assert the message arrived. The container path has two scripts of its
 * own; this is the half neither of them covers.
 *
 * ⚠️ IT SPENDS REAL MONEY. Opt in with CHAT_MCP_LIVE=1.
 *
 * 🛑 THE FREE CHECKS RUN FIRST AND THE PAID PROMPT IS GATED BEHIND THEM.
 * `cursor-agent mcp list` and `mcp list-tools` spend no model turn, and they
 * are the two that answer "is this child wired to the bus at all". A run that
 * paid for a turn only to discover an unapproved server is money spent on a
 * question the free commands already answer. Measured on #348: the config
 * alone leaves `chat: not loaded (needs approval)`.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSupervisor } from "../src/supervise/index.ts";
import { deliverToSupervisor } from "../src/supervise/socket.ts";
import { openDb } from "../src/storage/db.ts";
import * as dao from "../src/storage/dao.ts";
import { cursorSpawn } from "../src/adapters/cursor-spawn.ts";
import { readVendorToken } from "../src/supervise/auth.ts";

if (!process.env.CHAT_MCP_LIVE) {
  console.error(
    "Refusing: spawns a real host agent and spends money. CHAT_MCP_LIVE=1",
  );
  process.exit(1);
}

const HANDLE = `cacc-host-${process.pid}`;
const PROBE = `${HANDLE}-probe`;
const TOKEN = `CURSOR-HOST-${Date.now()}`;
const TURN_TIMEOUT_MS = Number(process.env.TURN_TIMEOUT_SECONDS ?? 240) * 1000;

const childCwd = mkdtempSync(join(tmpdir(), "cacc-host-"));
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

/** The vendor's own CLI, in the CHILD's directory, with its output captured. */
function cursor(args) {
  try {
    return execFileSync(cursorSpawn.binary, args, {
      cwd: childCwd,
      encoding: "utf8",
      timeout: 120_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    return `__ERROR__ ${err?.stdout ?? ""} ${err?.stderr ?? err?.message ?? ""}`;
  }
}

// The child's send is REFUSED unless the recipient is a registered peer.
dao.upsertAgent(db, {
  handle: PROBE,
  pid: process.pid,
  session_id: `cacc-host-${Date.now()}`,
  display_name: PROBE,
  metadata: { kind: "agent" },
});

record(
  "a real CURSOR_API_KEY is on file",
  Boolean(readVendorToken(cursorSpawn)),
);

console.log(`supervisor=${HANDLE}  probe=${PROBE}  cwd=${childCwd}`);
console.log(`binary=${cursorSpawn.binary}  token=${TOKEN}\n`);

let sup;

try {
  sup = await startSupervisor({
    handle: HANDLE,
    cwd: childCwd,
    db,

    // 🛑 THE HOST ALIAS, NOT `docker-cursor`. `drivers/index.ts` maps
    // `cursor` to (vendor cursor, mode host) — the whole point of this script.
    vendor: cursorSpawn,
    driver: "cursor",
    extraDirs: [childCwd],
    ephemeral: true,
    log: (line) => {
      logLines.push(line);
      if (process.env.VERBOSE) console.log(`    ${line}`);
    },
  });

  record("a host cursor supervisor STARTS", true, `socket=${sup.socketPath}`);

  // --- the FREE stage -------------------------------------------------------
  // 🛑 EVERYTHING BELOW THIS LINE UNTIL THE PROMPT COSTS NOTHING, and it is
  // where #348's defect lived. A failure here means the paid turn is pointless.

  const configPath = join(childCwd, ".cursor", "mcp.json");
  record(
    "the supervisor wrote .cursor/mcp.json into the CHILD's cwd",
    existsSync(configPath),
    configPath,
  );

  if (existsSync(configPath)) {
    const written = JSON.parse(readFileSync(configPath, "utf8"));
    record(
      "the written config names the CHILD's own handle, not the supervisor's",
      JSON.stringify(written).includes(HANDLE),
    );
  }

  const list = cursor(["mcp", "list"]);
  console.log(`\n  mcp list -> ${list.trim()}\n`);

  // 🛑 PARSE-OR-SAY-SO. "not ready" and "I could not read the output" are
  // different answers and must not collapse into one clean-looking line.
  record(
    "the script could PARSE `mcp list`",
    /chat|No MCP servers|__ERROR__/i.test(list),
    /chat|No MCP servers|__ERROR__/i.test(list)
      ? undefined
      : "unrecognised shape — every verdict below is untrustworthy",
  );

  record(
    "🛑 the chat server is READY, not merely SEEN (this is #348)",
    /chat:\s*ready/i.test(list),
    /needs approval/i.test(list)
      ? "still `needs approval` — the approval step did not run or did not take"
      : undefined,
  );

  const tools = cursor(["mcp", "list-tools", "chat"]);
  const toolCount = (tools.match(/^- /gm) ?? []).length;
  console.log(`  mcp list-tools chat -> ${toolCount} tool(s)\n`);

  record(
    "the bus tools are LOADED, and `send` is among them",
    /^- send /m.test(tools),
    `${toolCount} tool(s)`,
  );

  // --- the PAID stage -------------------------------------------------------
  // 🛑 GATED. Spending a turn on a child with no `send` buys nothing.
  const wired = checks.every((c) => c.ok);

  if (!wired) {
    console.log(
      "\n🛑 SKIPPING THE PAID TURN: the free checks say this child is not wired to the bus.",
    );
  } else {
    const ack = await deliverToSupervisor(HANDLE, {
      id: 1,
      to: HANDLE,
      from: "cacc-host-harness",
      body: `Please send a chat message to ${PROBE} with the body "${TOKEN}". Thanks.`,
      kind: "chat",
      ts: Date.now(),
    });

    record(
      "the socket ACKs the delivery",
      ack?.ok === true,
      JSON.stringify(ack),
    );

    const arrived = await until(
      () => probeBodies().some((b) => b.includes(TOKEN)),
      TURN_TIMEOUT_MS,
      `${TOKEN} on the bus`,
    );

    record(
      "🛑 the HOST Cursor agent called a bus tool and the message ARRIVED",
      arrived,
      arrived ? undefined : `probe saw ${probeBodies().length} message(s)`,
    );
  }
} catch (err) {
  record("a host cursor supervisor STARTS", false, String(err?.message ?? err));
} finally {
  await sup?.stop().catch(() => undefined);
  rmSync(childCwd, { recursive: true, force: true });
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
