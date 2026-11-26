import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CHAT_MCP_HOME = mkdtempSync(
  join(tmpdir(), "chat-mcp-handoff-prefix-"),
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
 * WIRING, which is a different claim: a correct preamble that no child is ever
 * handed is inert, and nothing in the other file can tell the two apart.
 *
 * 🛑 THE HOST ARM IS THE ONE WORTH THE SECOND TEST. The mount banner beside it
 * is container-only, so copying its gate would have shipped a host agent with
 * no handoff at all and a green suite.
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

test("🛑 a fresh container spawn is told about /work/HANDOFF.md on the FIRST prompt only", async () => {
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
    await deliverToSupervisor(handle, {
      id: 1,
      to: handle,
      from: "lee",
      ts: Date.now(),
      body: "hi",
    });

    assert.match(sent[0] ?? "", /\/work\/HANDOFF\.md/);

    children[0]?.finishTurn();
    await deliverToSupervisor(handle, {
      id: 2,
      to: handle,
      from: "lee",
      ts: Date.now(),
      body: "again",
    });

    assert.equal(sent.length, 2, "the second prompt must have been sent");
    assert.doesNotMatch(
      sent[1] ?? "",
      /HANDOFF\.md/,
      "the handoff pointer must not repeat every turn",
    );
  } finally {
    await sup.stop();
  }
});

test("🛑 a bare HOST spawn is told about its OWN project dir, not /work", async () => {
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
    await deliverToSupervisor(handle, {
      id: 1,
      to: handle,
      from: "lee",
      ts: Date.now(),
      body: "hi",
    });

    const expected = join(realpathSync(process.cwd()), "HANDOFF.md");

    assert.ok(
      (sent[0] ?? "").includes(expected),
      `the host prompt must name ${expected}, got:\n${sent[0]}`,
    );

    // 🛑 THE PAIRED CONTROL. Reusing the mount banner's container-only gate
    // would leave this arm silent, and reusing its PATH would send a host
    // agent to a directory that does not exist on the host.
    assert.doesNotMatch(
      sent[0] ?? "",
      /\/work\/HANDOFF\.md/,
      "a host agent has no container bind",
    );
  } finally {
    await sup.stop();
  }
});

test("⚠️ a RESUMED session is not handed the pointer again", async () => {
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
    await deliverToSupervisor(handle, {
      id: 1,
      to: handle,
      from: "lee",
      ts: Date.now(),
      body: "hi",
    });

    assert.equal(sent.length, 1, "the prompt must have been sent");
    assert.match(sent[0] ?? "", /hi/);

    // A resumed child still holds the turn where it was told. Repeating it is
    // noise on every resume, and the mount banner is gated the same way.
    assert.doesNotMatch(sent[0] ?? "", /HANDOFF\.md/);
  } finally {
    await sup.stop();
  }
});
