import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point CHAT_MCP_HOME at a scratch dir BEFORE importing anything that reads it.
process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), "chat-mcp-live-"));

const { WakeListener, listLiveSupervisors } =
  await import("../../src/supervise/socket.js");
const { socketDir, socketPathFor, ensureSocketDir } =
  await import("../../src/util/paths.js");

test("with no socket directory at all it reports none rather than throwing", async () => {
  rmSync(socketDir(), { recursive: true, force: true });

  assert.deepEqual(await listLiveSupervisors(), []);
});

test("a listening supervisor is reported, by handle", async () => {
  const l = await WakeListener.bind("alive", () => ({ ok: true }));

  try {
    const live = await listLiveSupervisors();

    assert.deepEqual(
      live.map((s) => s.handle),
      ["alive"],
    );
  } finally {
    await l.close();
  }
});

test("a stale socket file is NOT reported, and is NOT deleted", async () => {
  // 🛑 Debris belongs to `WakeListener.bind`, which probes before unlinking.
  // A reader that tidies up can race a supervisor binding at that moment.
  ensureSocketDir();
  const debris = socketPathFor("crashed");
  writeFileSync(debris, "");

  const live = await listLiveSupervisors();

  assert.deepEqual(
    live.map((s) => s.handle),
    [],
  );
  assert.equal(
    existsSync(debris),
    true,
    "the stale file must survive the read",
  );
});

test("a live supervisor is reported even beside stale debris", async () => {
  ensureSocketDir();
  writeFileSync(socketPathFor("crashed-too"), "");
  const l = await WakeListener.bind("still-here", () => ({ ok: true }));

  try {
    const live = await listLiveSupervisors();

    assert.deepEqual(
      live.map((s) => s.handle),
      ["still-here"],
    );
  } finally {
    await l.close();
  }
});

test("each live supervisor carries when its socket was bound", async () => {
  const before = Date.now();
  const l = await WakeListener.bind("timed", () => ({ ok: true }));

  try {
    const [s] = await listLiveSupervisors();

    assert.equal(typeof s.boundAt, "number");
    // Filesystem timestamps round down to the second on some filesystems, so
    // allow a second of slack below the moment the bind started.
    assert.ok(
      s.boundAt >= before - 1000 && s.boundAt <= Date.now() + 1000,
      `boundAt ${s.boundAt} is not within the bind window ${before}..${Date.now()}`,
    );
  } finally {
    await l.close();
  }
});
