import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  existsSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point CHAT_MCP_HOME at a scratch dir BEFORE importing anything that reads it.
process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), "chat-mcp-live-"));

const { WakeListener, listLiveSupervisors, boundAtOf } =
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

    // The listener is still open for the whole of this test, so nothing can
    // unlink the socket between the probe and the stat (#373).
    assert.ok(s.boundAt !== null, "a live supervisor has a known bind time");
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

test("a `.DS_Store` in the socket directory is skipped, not thrown on", async () => {
  // 🛑 THE FILESYSTEM IS A SECOND SOURCE OF HANDLES, AND IT IS NOT VALIDATED.
  // `socketPathFor` calls `assertHandle`, which THROWS on a leading dot — so
  // one Finder visit to ~/.chat-mcp/sock/ turned the whole live list into a
  // 500. The guard on the caller's own handle does not cover this. Measured by
  // claude1 reviewing PR 296.
  ensureSocketDir();
  writeFileSync(join(socketDir(), ".DS_Store"), "");
  const l = await WakeListener.bind("survivor", () => ({ ok: true }));

  try {
    const live = await listLiveSupervisors();

    assert.deepEqual(
      live.map((s) => s.handle),
      ["survivor"],
    );
  } finally {
    await l.close();
  }
});

/**
 * #373 — the bind time FAILS OPEN, and that is the whole defect.
 *
 * ⚠️ REACHABLE IN PRODUCTION, BUT NOT RELIABLY FROM A TEST.
 * `listLiveSupervisors` awaits `isLive` before it stats, so a supervisor that
 * unlinks inside that window hits the catch. Arranging that window is racy,
 * so `boundAtOf` is exported and covered directly instead.
 */
test("a socket whose file cannot be statted has an UNKNOWN bind time, not a new one", () => {
  const missing = socketPathFor("never-bound");

  assert.equal(existsSync(missing), false, "the fixture must not exist");
  assert.equal(boundAtOf(missing), null);
});

// The positive control. Without it the test above passes against a `boundAtOf`
// that returns null for everything, which would blank the age on every row.
test("a socket file that CAN be statted still reports its own mtime", () => {
  ensureSocketDir();
  const present = socketPathFor("statted");
  writeFileSync(present, "");

  const bound = boundAtOf(present);

  assert.equal(typeof bound, "number");
  assert.ok(
    bound !== null && Math.abs(bound - statSync(present).mtimeMs) < 1,
    `boundAtOf returned ${bound}, not the file's own mtime`,
  );
});
