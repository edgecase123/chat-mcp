import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import type { ShimContext } from "../../src/shim/index.js";

// 🛑 BEFORE any import that resolves a state path.
process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), "chat-mcp-peerref-"));

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } =
  await import("@modelcontextprotocol/sdk/inMemory.js");
const { openDb } = await import("../../src/storage/db.js");
const { NotifyBus } = await import("../../src/notify/bus.js");
const { buildServer } = await import("../../src/shim/index.js");
const { runSend } = await import("../../src/oneshot/send.js");
const dao = await import("../../src/storage/dao.js");
const { childHandleFor } = await import("../../src/supervise/grant.js");

/**
 * #297. `supervise <handle>` binds the socket as `<handle>` while the child
 * registers on the bus as `<handle>-agent`, so a send to the name the operator
 * typed was refused with "Unknown peer".
 *
 * 🛑 THAT REFUSAL IS WORD-FOR-WORD WHAT A DEAD AGENT PRODUCES. The operator
 * could not tell a naming slip from a failed spawn, which is the whole cost of
 * the ticket. When the sibling is registered, the refusal must say so.
 *
 * ⚠️ IT STILL REFUSES. The two names address two different processes, so
 * naming the sibling is advice, not a redirect.
 */

const SUPERVISOR = "peerref-super";

/** Register the CHILD only, exactly as a live supervised agent appears. */
function registerChildOnly(): string {
  const child = childHandleFor(SUPERVISOR);
  const db = openDb();

  try {
    dao.upsertAgent(db, {
      handle: child,
      pid: process.pid,
      session_id: randomUUID(),
    });
    assert.ok(dao.getAgent(db, child), "the fixture failed to register");
    assert.equal(
      dao.getAgent(db, SUPERVISOR),
      null,
      "the fixture must leave the BARE handle unregistered",
    );
  } finally {
    db.close();
  }

  return child;
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

/** The tool's thrown reason, as an agent reads it. */
async function sendToolRefusal(to: string): Promise<string> {
  const ctx = contextFor(`pr-${process.pid}-${randomUUID().slice(0, 8)}`);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "probe", version: "0" });
  const server = buildServer(ctx);
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

  const result = (await client.callTool({
    name: "send",
    arguments: { to, body: "hi" },
  })) as { isError?: boolean; content: { type: string; text: string }[] };

  await client.close();
  await server.close();
  ctx.db.close();

  assert.equal(result.isError, true, `send to ${to} must still be REFUSED`);
  const text = result.content[0]?.text;
  assert.ok(text, "the refusal must carry text content");

  return text;
}

/** `runSend`'s thrown reason, as an operator reads it. */
async function oneshotRefusal(to: string): Promise<string> {
  const err = await runSend({ to, body: "hi", from: "peerref-operator" }).then(
    () => null,
    (e: unknown) => e as Error,
  );
  assert.ok(err, `chat-mcp send ${to} must still be REFUSED`);

  return err.message;
}

/**
 * 🛑 THE WHOLE TICKET, ON BOTH SURFACES. A fix on one of the two send paths
 * leaves the other saying nothing, and the operator surface is the one the
 * smoke recipe uses.
 */
test("🚨 BOTH surfaces name the registered sibling when the bare handle misses", async () => {
  const child = registerChildOnly();

  const text = await sendToolRefusal(SUPERVISOR);
  assert.match(
    text,
    new RegExp(`"${child}" IS registered`),
    "the send TOOL did not name the sibling it found",
  );

  const message = await oneshotRefusal(SUPERVISOR);
  assert.match(
    message,
    new RegExp(`"${child}" IS registered`),
    "the one-shot CLI did not name the sibling it found",
  );
});

/**
 * 🛑 THE NAME IT OFFERS MUST BE THE ONE THAT WORKS, not a near miss. The
 * refusal is advice an operator retypes, so a suffix typo here costs the same
 * dead-end round trip the ticket is about.
 */
test("🚨 the name offered is exactly childHandleFor's, suffix and all", async () => {
  registerChildOnly();

  const text = await sendToolRefusal(SUPERVISOR);

  assert.match(text, /send to "peerref-super-agent"/);
  assert.match(
    text,
    new RegExp(`"${SUPERVISOR}" is the supervisor you started it with`),
    "it must also say what the handle they typed actually is",
  );
});

/**
 * 🛑 THE CONTROL, AND IT IS THE ONE THAT CATCHES AN UNCONDITIONAL CLAUSE. A
 * refusal that named a sibling for EVERY miss would pass the two tests above
 * while telling an operator who simply mistyped to go and message a handle
 * that does not exist either.
 */
test("🚨 a miss with NO registered sibling keeps its own surface advice", async () => {
  const text = await sendToolRefusal("peerref-nobody");

  assert.match(text, /Call list_agents/, "the tool's own next step is gone");
  assert.doesNotMatch(text, /IS registered/);
  assert.doesNotMatch(text, /supervisor you started it with/);

  const message = await oneshotRefusal("peerref-nobody");

  assert.match(message, /chat-mcp list --all/, "the CLI's next step is gone");
  assert.doesNotMatch(message, /IS registered/);
});

/**
 * ⚠️ THE OVER-CORRECTION. An operator told about `-agent` once may append it
 * to a handle that never had a child, and `childHandleFor` then derives
 * `<x>-agent-agent`. Nothing is registered under that, so the plain advice is
 * the honest answer rather than a second suffix to try.
 */
test("🚨 a target already ending in -agent is not offered a second suffix", async () => {
  const text = await sendToolRefusal("peerref-nobody-agent");

  assert.doesNotMatch(text, /-agent-agent/);
  assert.match(text, /Call list_agents/);
});

/**
 * 🛑 THE ROOM BRANCH STILL WINS. A `#room` is never an agent row, so deriving
 * `#room-agent` and advising it would strand the reader — and
 * `room-target-refusal.test.ts` pins the sentence a room must get.
 */
test("🚨 a #room target keeps the room advice, not a sibling suggestion", async () => {
  const text = await sendToolRefusal("#mcp");

  assert.match(text, /room_send/);
  assert.doesNotMatch(text, /IS registered/);

  const message = await oneshotRefusal("#mcp");

  assert.match(message, /\/join/);
  assert.doesNotMatch(message, /IS registered/);
});
