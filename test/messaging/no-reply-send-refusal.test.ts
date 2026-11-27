import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import type { ShimContext } from "../../src/shim/index.js";

// 🛑 BEFORE any import that resolves a state path.
process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), "chat-mcp-noreply-"));

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } =
  await import("@modelcontextprotocol/sdk/inMemory.js");
const { openDb } = await import("../../src/storage/db.js");
const { NotifyBus } = await import("../../src/notify/bus.js");
const { buildServer } = await import("../../src/shim/index.js");
const { runSend } = await import("../../src/oneshot/send.js");
const dao = await import("../../src/storage/dao.js");

/**
 * #475. A DM to a supervised child started with `--no-reply` was delivered,
 * read, and never answered, and the SENDER was told nothing at all.
 *
 * 🛑 THE REFUSAL MUST NOT ACCUSE THE AGENT. `silentReplyWarning` says the
 * agent kept its answer; here it was never given the tool, so the same words
 * would blame it for an operator's flag. That accusation class is #417.
 *
 * 🛑 `NULL` MEANS UNKNOWN AND MUST SEND. A crashed supervisor leaves a stale
 * flag, and a DM refused because of debris is worse than the silence this
 * ticket is about.
 */

function register(handle: string, canReply: number | null): void {
  const db = openDb();
  try {
    dao.upsertAgent(db, {
      handle,
      pid: process.pid,
      session_id: randomUUID(),
      display_name: handle,
      metadata: { kind: "agent" },
    });
    dao.setAgentCanReply(db, handle, canReply);
    assert.equal(
      dao.getAgent(db, handle)?.can_reply,
      canReply,
      "the fixture did not store can_reply",
    );
  } finally {
    db.close();
  }
}

function contextFor(handle: string): ShimContext {
  return {
    handle,
    sandbox: "host",
    session_id: randomUUID(),
    db: openDb(),
    notify: new NotifyBus(handle),
    adapterStatus: { installed: true, framework: null, hint: null },
  };
}

interface ToolResult {
  isError?: boolean;
  content: { type: string; text: string }[];
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const ctx = contextFor(`nr-${process.pid}-${randomUUID().slice(0, 8)}`);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "probe", version: "0" });
  const server = buildServer(ctx);
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

  const result = (await client.callTool({
    name,
    arguments: args,
  })) as ToolResult;

  await client.close();
  await server.close();
  ctx.db.close();

  return result;
}

/**
 * 🛑 BOTH SURFACES, for `unknown-peer-refusal.test.ts`'s reason. A fix on one
 * send path leaves the other saying nothing, and the one-shot CLI is the
 * surface the smoke recipe uses.
 */
test("🚨 can_reply = 0 refuses the DM on BOTH send surfaces", async () => {
  const target = `nr-mute-${process.pid}`;
  register(target, 0);

  const viaTool = await callTool("send", { to: target, body: "hi" });
  assert.equal(viaTool.isError, true, "the send TOOL delivered a silent DM");
  const text = viaTool.content[0]?.text ?? "";
  assert.match(text, /no reply tool/i, "the refusal must name the cause");
  assert.doesNotMatch(
    text,
    /withheld|kept|did not answer/i,
    "the refusal must not accuse the agent — #417",
  );

  const err = await runSend({
    to: target,
    body: "hi",
    from: `nr-op-${process.pid}`,
  }).then(
    () => null,
    (e: unknown) => e as Error,
  );
  assert.ok(err, "the one-shot CLI delivered a silent DM");
  assert.match(err.message, /no reply tool/i);
});

/**
 * ⚠️ THE PAIRED POSITIVE CONTROL. Without it the refusal could refuse
 * everything and this file would still pass.
 */
test("🚨 can_reply = NULL still SENDS, because unknown must fail open", async () => {
  const target = `nr-unknown-${process.pid}`;
  register(target, null);

  const result = await callTool("send", { to: target, body: "hi" });
  assert.notEqual(
    result.isError,
    true,
    "an unknown can_reply was treated as a refusal — fail OPEN",
  );
});

test("🚨 can_reply = 1 sends, so the flag is read and not assumed", async () => {
  const target = `nr-live-${process.pid}`;
  register(target, 1);

  const result = await callTool("send", { to: target, body: "hi" });
  assert.notEqual(result.isError, true);
});
