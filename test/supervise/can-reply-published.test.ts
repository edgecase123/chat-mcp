import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// 🛑 BEFORE any import that resolves a state path. See replace-child.test.ts.
process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), "chat-mcp-canreply-"));

const { migrate } = await import("../../src/storage/db.js");
const { startSupervisor } = await import("../../src/supervise/index.js");
const dao = await import("../../src/storage/dao.js");
const { childHandleFor } = await import("../../src/supervise/grant.js");
import type { AgentChild, SpawnOptions } from "../../src/supervise/child.js";
import { supervisorOptions } from "../support/supervisor-options.js";

/**
 * #475. The WIRING, not the publisher. `can-reply.test.ts` proves the retry
 * and the fail-open rule; this proves the supervisor actually calls it.
 *
 * 🛑 WITHOUT THIS THE WHOLE FEATURE CAN BE UNWIRED AND EVERY OTHER TEST STILL
 * PASSES. The refusal reads a column nothing writes, so a DM to a `--no-reply`
 * child is delivered and unanswered exactly as before the ticket.
 */

const spawnChild = (_opts: SpawnOptions): AgentChild => ({
  reportsUsage: false,
  reportsContext: true,
  send: () => undefined,
  onTurnEnd: () => undefined,
  onContext: () => undefined,
  onUsage: () => undefined,
  onDenial: () => undefined,
  onToolCall: () => undefined,
  onSession: (cb) => cb("sess"),
  onEvent: () => undefined,
  onStderr: () => undefined,
  onExit: () => undefined,
  kill: () => undefined,
});

function liveDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  migrate(db);

  return db;
}

/** Register the child exactly as the SHIM does, after the supervisor is up. */
function registerChild(db: DatabaseSync, child: string): void {
  dao.upsertAgent(db, {
    handle: child,
    pid: process.pid,
    session_id: randomUUID(),
    display_name: child,
    metadata: { kind: "agent" },
  });
}

async function waitForCanReply(
  db: DatabaseSync,
  child: string,
  want: number | null,
): Promise<number | null | undefined> {
  for (let i = 0; i < 200; i += 1) {
    const seen = dao.getAgent(db, child)?.can_reply;
    if (seen === want) return seen;
    await new Promise((r) => setTimeout(r, 5));
  }

  return dao.getAgent(db, child)?.can_reply;
}

/**
 * 🛑 THE ROW IS ABSENT WHEN THE SUPERVISOR STARTS, and that is the ordinary
 * case rather than an edge one. The retry is the only reason the flag is ever
 * published at all.
 */
test("🚨 --no-reply publishes 0 once the child registers, not before", async () => {
  const db = liveDb();
  const handle = `cr-mute-${process.pid}`;
  const child = childHandleFor(handle);

  const sup = await startSupervisor(
    supervisorOptions({
      handle,
      db,
      reply: false,
      canReplyRetryMs: 5,
      extraDirs: [process.cwd()],
      spawnChild,
      log: () => undefined,
    }),
  );

  try {
    assert.equal(
      dao.getAgent(db, child),
      null,
      "the fixture must start with NO row — that is the case under test",
    );

    registerChild(db, child);
    assert.equal(
      await waitForCanReply(db, child, 0),
      0,
      "the supervisor never published can_reply after the child registered",
    );
  } finally {
    await sup.stop();
  }

  assert.equal(
    dao.getAgent(db, child)?.can_reply,
    null,
    "stop must withdraw the flag, so debris cannot refuse a live child",
  );
  db.close();
});

/**
 * ⚠️ THE PAIRED POSITIVE CONTROL. Without it the supervisor could publish 0
 * unconditionally and the test above would not notice.
 */
test("🚨 a child WITH a send tool publishes 1, so the value is derived", async () => {
  const db = liveDb();
  const handle = `cr-live-${process.pid}`;
  const child = childHandleFor(handle);

  const sup = await startSupervisor(
    supervisorOptions({
      handle,
      db,
      canReplyRetryMs: 5,
      extraDirs: [process.cwd()],
      spawnChild,
      log: () => undefined,
    }),
  );

  try {
    registerChild(db, child);
    assert.equal(
      await waitForCanReply(db, child, 1),
      1,
      "the default grant holds mcp__chat__send, so this must publish 1",
    );
  } finally {
    await sup.stop();
  }

  db.close();
});
