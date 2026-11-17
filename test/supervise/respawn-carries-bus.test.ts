import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 🛑 BEFORE any import that resolves a state path, or the supervisor binds a
// socket inside the OPERATOR'S LIVE ~/.chat-mcp.
process.env.CHAT_MCP_HOME = mkdtempSync(
  join(tmpdir(), "chat-mcp-respawn-bus-"),
);

const { migrate } = await import("../../src/storage/db.js");
const { startSupervisor } = await import("../../src/supervise/index.js");
const { deliverToSupervisor } = await import("../../src/supervise/socket.js");
const { claudeSpawn } = await import("../../src/adapters/claude-spawn.js");
const { setToken } = await import("../../src/supervise/auth.js");
const { markConfirmed } = await import("../../src/supervise/container.js");
import type { AgentChild, SpawnOptions } from "../../src/supervise/child.js";

/**
 * 🛑 A CONTAINERIZED RESPAWN USED TO DROP `bus` AND THE AGENT DIED.
 *
 * `hostBus` is a local in `startSupervisor`, not a member of `opts`, so the
 * `...opts` spread that both respawn paths use does not carry it. Only the
 * first spawn named `bus:` explicitly. `containerized.ts` then refuses a
 * granted spawn with no endpoint, the throw left NO agent running, and the
 * socket file stayed behind so the handle still looked alive.
 *
 * ⚠️ `bus` IS OPTIONAL ON `SpawnOptions`, so omitting it typechecks clean.
 * `npm run typecheck` could never have said no.
 *
 * 🛑 THE EXISTING RESPAWN TESTS COULD NOT HAVE SAID NO EITHER. Their fake
 * `spawnChild` only chooses whether to THROW; it never inspects the options it
 * was handed, so a respawn carrying `bus` and one omitting it are the same run.
 * These tests assert the options.
 *
 * Both assert EQUALITY WITH THE FIRST SPAWN rather than mere presence, and
 * each one first asserts the first spawn's endpoint is defined — without that
 * control, `undefined === undefined` passes on the broken code.
 */
function recordingChild(children: SpawnOptions[]) {
  return (opts: SpawnOptions): AgentChild => {
    children.push(opts);

    return {
      reportsUsage: false,
      reportsContext: true,
      send: () => undefined,
      onTurnEnd: () => undefined,
      onContext: () => undefined,
      onUsage: () => undefined,
      onDenial: () => undefined,
      onSession: (cb) => cb("sess-from-fake"),
      onEvent: () => undefined,
      onStderr: () => undefined,
      onExit: () => undefined,
      kill: () => undefined,
    };
  };
}

async function containerSupervisor(handle: string, children: SpawnOptions[]) {
  const db = new DatabaseSync(":memory:");
  migrate(db);

  // The container gate, satisfied in the temp CHAT_MCP_HOME above — not the
  // operator's real one.
  setToken("sk-ant-oat-x");
  markConfirmed(handle);

  const sup = await startSupervisor({
    handle,
    vendor: claudeSpawn,
    db,
    extraDirs: [process.cwd()],
    // 🛑 THE FLAG THAT OPENS `hostBus` AT ALL. Without it the first spawn has
    // no endpoint either and every assertion below is vacuous.
    container: true,
    spawnChild: recordingChild(children),
    log: () => undefined,
  });

  return { sup, db };
}

async function deliver(
  handle: string,
  envelope: Record<string, unknown>,
): Promise<void> {
  await deliverToSupervisor(handle, {
    id: Number(envelope.id),
    to: handle,
    from: "lee",
    ts: Date.now(),
    ...envelope,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any).then(
    () => undefined,
    () => undefined,
  );
}

test("🚨 a RESTART respawn carries the bus endpoint the first spawn got", async () => {
  const children: SpawnOptions[] = [];
  const handle = `bus-${process.pid}-restart`;
  const { sup } = await containerSupervisor(handle, children);

  try {
    // The non-vacuity control: without an endpoint on call 1 there is nothing
    // for call 2 to lose.
    assert.ok(
      children[0]?.bus,
      "the first containerized spawn got no bus endpoint, so this test proves nothing",
    );

    await deliver(handle, { id: 1, control: { kind: "restart", mode: "now" } });

    assert.equal(children.length, 2, "the restart did not respawn");
    assert.deepEqual(
      children[1]?.bus,
      children[0]?.bus,
      "the restart respawn dropped the bus endpoint, so a real containerized spawn would refuse",
    );
  } finally {
    await sup.stop();
  }
});

test("🚨 an APPROVAL replacement carries the bus endpoint the first spawn got", async () => {
  const children: SpawnOptions[] = [];
  const handle = `bus-${process.pid}-approve`;
  const { sup } = await containerSupervisor(handle, children);

  try {
    assert.ok(
      children[0]?.bus,
      "the first containerized spawn got no bus endpoint, so this test proves nothing",
    );

    await deliver(handle, {
      id: 1,
      approval: {
        approvalId: 1,
        decision: "approve" as const,
        requested: "rm in '/tmp/x.txt'",
        grant: "Bash(rm -f /tmp/x.txt)",
        sessionId: "sess-1",
      },
    });

    assert.equal(children.length, 2, "the approval did not replace the child");
    assert.deepEqual(
      children[1]?.bus,
      children[0]?.bus,
      "the approval replacement dropped the bus endpoint, so approving a command would kill the agent",
    );
  } finally {
    await sup.stop();
  }
});
