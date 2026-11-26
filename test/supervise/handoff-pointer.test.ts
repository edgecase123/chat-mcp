import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CHAT_MCP_HOME = mkdtempSync(
  join(tmpdir(), "chat-mcp-handoff-pointer-"),
);

const { migrate } = await import("../../src/storage/db.js");
const { startSupervisor } = await import("../../src/supervise/index.js");
const { deliverToSupervisor } = await import("../../src/supervise/socket.js");
const { setToken } = await import("../../src/supervise/auth.js");
import { supervisorOptions } from "../support/supervisor-options.js";
import { confirmHandle } from "../support/confirm-plan.js";

const DIRS = [process.cwd()];

/* ==========================================================================
 * 🛑 WHY THIS FILE EXISTS, BESIDE `handoff-preamble.test.ts`. That one holds
 * the TEXT and the path arithmetic as pure functions. This one holds the
 * WIRING, which is a different claim: a correct preamble no child is ever
 * handed is inert, and nothing in the other file can tell the two apart.
 *
 * 🛑 THE POINTER IS ITS OWN PROMPT, NOT A PREFIX, AND THE LAST TEST HERE IS
 * WHY. Shipped as a prefix on the first inbound prompt it pushed the `alert`
 * banner off the front of the string the agent acts on, and pushed the message
 * BODY out of the log excerpt. The gate caught it in one assertion in
 * `child-output-logged.test.ts`; this file now pins the cause directly,
 * because that test is about log truncation and would send the next reader to
 * the wrong half of the arc.
 *
 * 🛑 THE HOST ARM IS THE OTHER REASON. `mountBannerPrefix` beside it in the
 * source is container-only, so copying its gate would have shipped a host
 * agent with no handoff at all and a green suite.
 * ========================================================================== */

function fakeChild(sent: string[]) {
  let endTurn: (() => void) | undefined;
  return {
    opts: undefined as unknown,
    reportsUsage: false,
    reportsContext: true,
    send: (t: string) => sent.push(t),
    onTurnEnd: (cb: () => void) => {
      endTurn = cb;
    },
    onContext: () => undefined,
    onUsage: () => undefined,
    onDenial: () => undefined,
    onToolCall: () => undefined,
    onSession: (cb: (id: string) => void) => cb("sess-1"),
    onEvent: () => undefined,
    onStderr: () => undefined,
    onExit: () => undefined,
    kill: () => undefined,
    finishTurn: () => endTurn?.(),
  };
}

test("🛑 a fresh container spawn is handed /work/HANDOFF.md as its own first turn", async () => {
  const db = new DatabaseSync(":memory:");
  migrate(db);
  const handle = `ho-docker-${process.pid}`;
  setToken("sk-ant-oat-x");
  confirmHandle(handle);

  const sent: string[] = [];
  const children: ReturnType<typeof fakeChild>[] = [];
  const sup = await startSupervisor(
    supervisorOptions({
      handle,
      db,
      extraDirs: DIRS,
      driver: "docker-claude",
      container: true,
      log: () => undefined,
      spawnChild: () => {
        const c = fakeChild(sent);
        children.push(c);
        return c;
      },
    }),
  );

  try {
    // 🛑 BEFORE ANY BUS MESSAGE, which is the whole difference from the mount
    // banner. An agent that is never messaged would otherwise never learn
    // where its handoff is, and that is the continuity case #463 is about.
    assert.equal(sent.length, 1, "the pointer must be sent at start");
    assert.match(sent[0] ?? "", /\/work\/HANDOFF\.md/);

    children[0]?.finishTurn();
    await deliverToSupervisor(handle, {
      id: 1,
      to: handle,
      from: "lee",
      ts: Date.now(),
      body: "hi",
    });

    assert.equal(sent.length, 2, "the bus message must follow it");
    assert.match(sent[1] ?? "", /hi/);
    assert.doesNotMatch(
      sent[1] ?? "",
      /HANDOFF\.md/,
      "the pointer must not ride every turn",
    );
  } finally {
    await sup.stop();
  }
});

test("🛑 a bare HOST spawn is handed its OWN project dir, not /work", async () => {
  const db = new DatabaseSync(":memory:");
  migrate(db);
  const handle = `ho-host-${process.pid}`;

  const sent: string[] = [];
  const sup = await startSupervisor(
    supervisorOptions({
      handle,
      db,
      extraDirs: DIRS,
      log: () => undefined,
      spawnChild: () => fakeChild(sent),
    }),
  );

  try {
    const expected = join(realpathSync(process.cwd()), "HANDOFF.md");

    assert.equal(sent.length, 1, "the pointer must be sent at start");
    assert.ok(
      (sent[0] ?? "").includes(expected),
      `the host pointer must name ${expected}, got:\n${sent[0]}`,
    );

    // 🛑 THE PAIRED CONTROL. Reusing the mount banner's container-only gate
    // leaves this arm silent; reusing its PATH sends a host agent to a
    // directory that does not exist on the host.
    assert.doesNotMatch(
      sent[0] ?? "",
      /\/work\/HANDOFF\.md/,
      "a host agent has no container bind",
    );
  } finally {
    await sup.stop();
  }
});

test("⚠️ a RESUMED session is not handed the pointer at all", async () => {
  const db = new DatabaseSync(":memory:");
  migrate(db);
  const handle = `ho-resume-${process.pid}`;

  const sent: string[] = [];
  const sup = await startSupervisor(
    supervisorOptions({
      handle,
      db,
      extraDirs: DIRS,
      resumeSessionId: "sess-earlier",
      log: () => undefined,
      spawnChild: () => fakeChild(sent),
    }),
  );

  try {
    // A resumed child still holds the turn where it was told, and spending a
    // turn to repeat it on every resume is pure noise.
    assert.equal(sent.length, 0, "a resume must not spend a turn on it");

    await deliverToSupervisor(handle, {
      id: 1,
      to: handle,
      from: "lee",
      ts: Date.now(),
      body: "hi",
    });

    assert.equal(sent.length, 1);
    assert.match(sent[0] ?? "", /hi/);
    assert.doesNotMatch(sent[0] ?? "", /HANDOFF\.md/);
  } finally {
    await sup.stop();
  }
});

/**
 * 🔴 THE REGRESSION THIS FEATURE SHIPPED ONCE, AND THE GATE CAUGHT IT.
 *
 * As a prefix on the first inbound prompt, the pointer displaced the `alert`
 * banner from the front of the string. A turn is handed ONE string, and the
 * banner is the only thing carrying "handle this before anything queued behind
 * it" — so a BLOCKING message arrived opening with a paragraph about a file.
 *
 * ⚠️ PINNED HERE AND NOT ONLY IN `child-output-logged.test.ts`. That test goes
 * red on the same mutation, but it is about log truncation: a reader sent there
 * learns the excerpt is short, not that an alert lost its banner.
 */
test("🔴 an ALERT prompt still OPENS with its banner once the pointer exists", async () => {
  const db = new DatabaseSync(":memory:");
  migrate(db);
  const handle = `ho-alert-${process.pid}`;

  const sent: string[] = [];
  const children: ReturnType<typeof fakeChild>[] = [];
  const sup = await startSupervisor(
    supervisorOptions({
      handle,
      db,
      extraDirs: DIRS,
      log: () => undefined,
      spawnChild: () => {
        const c = fakeChild(sent);
        children.push(c);
        return c;
      },
    }),
  );

  try {
    // The pointer holds the first turn, so release it before the alert.
    children[0]?.finishTurn();
    await deliverToSupervisor(handle, {
      id: 1,
      to: handle,
      from: "lee",
      ts: Date.now(),
      body: "the gate is red on main",
      kind: "alert",
    });

    const prompt = sent.at(-1) ?? "";

    assert.ok(
      prompt.startsWith("🚨 ALERT"),
      `an alert must OPEN with its banner, got:\n${prompt}`,
    );
    assert.match(prompt, /the gate is red on main/);
  } finally {
    await sup.stop();
  }
});
