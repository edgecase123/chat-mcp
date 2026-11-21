import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CHAT_MCP_HOME = mkdtempSync(
  join(tmpdir(), "chat-mcp-mount-banner-"),
);

const { migrate } = await import("../../src/storage/db.js");
const { startSupervisor } = await import("../../src/supervise/index.js");
const { deliverToSupervisor } = await import("../../src/supervise/socket.js");
const { setToken } = await import("../../src/supervise/auth.js");
const { registerMount } = await import("../../src/supervise/mounts.js");
import { supervisorOptions } from "../support/supervisor-options.js";
import { confirmHandle } from "../support/confirm-plan.js";

const DIRS = [process.cwd()];

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
    onSession: (cb: (id: string) => void) => cb("sess-1"),
    onEvent: () => undefined,
    onStderr: () => undefined,
    onExit: () => undefined,
    kill: () => undefined,
    finishTurn: () => endTurn?.(),
  };
}

test("a fresh container spawn prepends the mount banner to the FIRST prompt only", async () => {
  const db = new DatabaseSync(":memory:");
  migrate(db);
  const handle = `mb-${process.pid}`;
  setToken("sk-ant-oat-x");

  const extra = mkdtempSync(join(tmpdir(), "chat-mcp-mb-extra-"));
  registerMount(handle, "local-context", extra);

  // 🛑 CONFIRMED AFTER THE MOUNT, because the mount is part of the plan. An
  // approval taken first is an approval of a different container, and the gate
  // now says so rather than starting it.
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
    assert.match(
      sent[0] ?? "",
      /Mounted directories:.*"local-context" -> \/mnt\/local-context/s,
    );

    children[0]?.finishTurn();
    await deliverToSupervisor(handle, {
      id: 2,
      to: handle,
      from: "lee",
      ts: Date.now(),
      body: "again",
    });
    assert.equal(
      sent.length,
      2,
      "the second prompt must actually have been sent",
    );
    assert.match(sent[1] ?? "", /again/);
    assert.doesNotMatch(
      sent[1] ?? "",
      /Mounted directories:/,
      "the banner must not repeat",
    );
  } finally {
    await sup.stop();
  }
});

test("the docker-claude driver gets the mount banner even without an explicit container flag", async () => {
  const db = new DatabaseSync(":memory:");
  migrate(db);
  const handle = `mb-driver-only-${process.pid}`;
  setToken("sk-ant-oat-x");

  const extra = mkdtempSync(join(tmpdir(), "chat-mcp-mb-extra-"));
  registerMount(handle, "local-context", extra);

  // 🛑 CONFIRMED AFTER THE MOUNT, because the mount is part of the plan. An
  // approval taken first is an approval of a different container, and the gate
  // now says so rather than starting it.
  confirmHandle(handle);

  const sent: string[] = [];
  const sup = await startSupervisor(
    supervisorOptions({
      handle,
      db,
      extraDirs: DIRS,
      driver: "docker-claude",
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
    assert.equal(sent.length, 1, "the prompt must actually have been sent");
    assert.match(
      sent[0] ?? "",
      /Mounted directories:.*"local-context" -> \/mnt\/local-context/s,
    );
  } finally {
    await sup.stop();
  }
});

test("a non-container (bare host) spawn never gets a mount banner", async () => {
  const db = new DatabaseSync(":memory:");
  migrate(db);
  const handle = `mb-bare-${process.pid}`;

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
    assert.equal(sent.length, 1, "the prompt must actually have been sent");
    assert.match(sent[0] ?? "", /hi/);
    assert.doesNotMatch(sent[0] ?? "", /Mounted directories:/);
  } finally {
    await sup.stop();
  }
});

/**
 * 🔴 #353's SECOND SURFACE, found by claude2 on PR 357. `registerMount`
 * validates the DIRECTORY and never the KEY, so a key carrying `", "` made one
 * mount read as two and told the agent it had a directory it does not.
 *
 * ⚠️ THE READER IS THE AGENT, NOT THE OPERATOR. No two distinct key sets ever
 * rendered identically here, because the entry embeds the key twice around a
 * fixed ` -> `. This misinformed the child; it never corrupted consent.
 */
test("🔴 a mount key containing a comma and a space stays ONE entry of two", async () => {
  const db = new DatabaseSync(":memory:");
  migrate(db);
  const handle = `mb-comma-${process.pid}`;
  setToken("sk-ant-oat-x");

  // 🛑 TWO MOUNTS, NOT ONE. With one, the line count cannot fail: the old
  // joined format put everything on a single line, and that line contained
  // `" -> /mnt/"` too. The assertion whose MESSAGE explains the defect has to
  // be the one that goes red. Caught by claude2 on PR 357.
  const extra = mkdtempSync(join(tmpdir(), "chat-mcp-mb-comma-"));
  const extra2 = mkdtempSync(join(tmpdir(), "chat-mcp-mb-comma2-"));
  registerMount(handle, "data, backup", extra);
  registerMount(handle, "memory", extra2);
  confirmHandle(handle);

  const sent: string[] = [];
  const sup = await startSupervisor(
    supervisorOptions({
      handle,
      db,
      extraDirs: DIRS,
      container: true,
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

    const banner = sent[0] ?? "";
    const entryLines = banner
      .split("\n")
      .filter((line) => line.includes(" -> /mnt/"));

    assert.equal(
      entryLines.length,
      2,
      `two mounts must print as two lines, got:\n${banner}`,
    );
    assert.match(banner, /"data, backup" -> \/mnt\/data, backup/);
    assert.match(banner, /"memory" -> \/mnt\/memory/);
  } finally {
    await sup.stop();
  }
});
