import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 🛑 BEFORE any import that resolves a state path.
process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), "chat-mcp-bind-reg-"));

const { openHostBus } = await import("../../src/supervise/host-bus.js");
const { openDb } = await import("../../src/storage/db.js");
const dao = await import("../../src/storage/dao.js");

/**
 * 🛑 A HOST CHILD REGISTERS AT PROCESS START; A CONTAINERIZED ONE DID NOT
 * REGISTER AT ALL. The host path runs the shim as its own process, so
 * `shimContextFor` fires unconditionally. A container reaches the same code
 * only through `serverFor`, which needs an MCP SESSION — and `cursor-agent`
 * opens one lazily, on its first chat tool call. A turn that needed only
 * `Read` never opened one, so `/api/agents/live` found no `childHandle` and
 * the sidebar row was never clickable.
 *
 * Measured on #463: `host a1-agent` had a row with no turn dispatched;
 * `container cursor1-agent` had none after a turn that SUCCEEDED.
 */
test("🚨 a bound host bus registers the child BEFORE any session opens", async (t) => {
  const bus = await openHostBus("bind1-agent");
  t.after(() => bus.close());

  const db = openDb();
  t.after(() => db.close());

  const agent = dao.getAgent(db, "bind1-agent");

  assert.ok(
    agent,
    "no row at bind, so the UI has no childHandle and the row cannot be clicked",
  );
  assert.equal(agent.handle, "bind1-agent");
});

/**
 * 🛑 THE ROW MUST EXIST AND MUST NOT READ AS LIVE. `shimContextFor` writes
 * `pid: process.pid`, which at bind time is the SUPERVISOR's — so a child that
 * never starts would present as online and a sibling would route work to
 * nothing. That is the `clearAgentPid`-on-teardown failure inverted.
 *
 * `clearAgentPid`'s own docblock prescribes the repair: *"Nulling the pid is
 * the whole repair, because `isProcessAlive(null)` is false"*.
 *
 * ⚠️ THE PAIR IS THE POINT. Test one alone passes for an implementation that
 * trades an invisible agent for a phantom one, and the phantom is worse.
 */
test("🛑 a bound bus with NO child does not present as online", async (t) => {
  const bus = await openHostBus("bind2-agent");
  t.after(() => bus.close());

  const db = openDb();
  t.after(() => db.close());

  const agent = dao.getAgent(db, "bind2-agent");

  assert.ok(agent, "the row must exist for the sidebar to offer it");
  assert.equal(
    agent.online,
    false,
    "a bound bus with no child read as a live agent, so work routes to nothing",
  );
  assert.equal(
    agent.pid,
    null,
    "online is isProcessAlive(pid), so pid drives it",
  );
});
