import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// 🛑 BEFORE any import that resolves a state path.
process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), "chat-mcp-reg-lock-"));

/**
 * `agents.json` is a read-modify-write with no lock, which is #377's defect
 * one file over.
 *
 * 🛑 THE CONSEQUENCE IS A REGISTRATION THAT VANISHES WITH NOTHING SAID. Two
 * overlapping writers both read the whole document, each splices its own
 * handle in, and the later write puts back a document that never had the
 * earlier handle in it. The operator's card reports success either way.
 *
 * ⚠️ `writeRegistrations` ALREADY STAGES AND RENAMES, so a TORN read is
 * already impossible. What is open is the LOST UPDATE, which atomicity of a
 * single write cannot close.
 *
 * `POST /api/agents/register` and the CLI's `project set` are both callers,
 * and the web server can be running while either is used.
 *
 * Mirrors `container-state-lock.test.ts`, deliberately — the same barrier
 * harness, because a race sampled by spawning children and hoping is tuned to
 * one laptop.
 */

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const FIXTURE = "test/support/fixtures/registrations-writer.ts";

function onDisk(path: string): { agents?: Record<string, unknown> } {
  return JSON.parse(readFileSync(path, "utf8")) as {
    agents?: Record<string, unknown>;
  };
}

/** Lock and staging files that outlived the writers. */
function leftovers(home: string): string[] {
  return readdirSync(home)
    .filter((f) => f.includes("agents.json") && f !== "agents.json")
    .sort();
}

/**
 * Run `writers` as separate processes that all enter the write window at once.
 *
 * 🛑 THE BARRIER IS CREATED LAST, AFTER EVERY CHILD HAS SAID IT IS READY, so
 * the overlap is constructed rather than sampled.
 */
async function race(
  home: string,
  writers: readonly { mode: "register" | "forget"; handle: string }[],
): Promise<void> {
  const barrier = join(home, "barrier");
  const ready = writers.map((_, i) => join(home, `ready-${i}`));

  const children = writers.map((writer, i) =>
    spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        FIXTURE,
        writer.mode,
        writer.handle,
        ready[i],
        barrier,
      ],
      {
        cwd: REPO_ROOT,
        // ⚠️ `CHAT_MCP_HOME` IS PASSED EXPLICITLY. A child inherits
        // `NODE_TEST_CONTEXT`, so `stateDir()` refuses rather than resolving
        // the operator's live `~/.chat-mcp`.
        env: { ...process.env, CHAT_MCP_HOME: home },
        stdio: ["ignore", "pipe", "pipe"],
      },
    ),
  );

  const exits = children.map(
    (child, i) =>
      new Promise<void>((resolve, reject) => {
        let stderr = "";
        child.stderr.on("data", (chunk) => (stderr += String(chunk)));
        child.on("error", reject);
        child.on("exit", (code) =>
          code === 0
            ? resolve()
            : reject(
                new Error(
                  `writer ${i} (${writers[i].handle}) exited ${code}\n${stderr}`,
                ),
              ),
        );
      }),
  );

  try {
    const deadline = Date.now() + 60_000;

    while (!ready.every((path) => existsSync(path))) {
      if (Date.now() >= deadline) {
        throw new Error(
          `only ${ready.filter((p) => existsSync(p)).length} of ${ready.length} writers reported ready`,
        );
      }
      await new Promise((r) => setTimeout(r, 10));
    }

    writeFileSync(barrier, "go\n");
    await Promise.all(exits);
  } finally {
    for (const child of children) child.kill("SIGKILL");
  }
}

/**
 * 🛑 EIGHT REAL PROCESSES, NOT EIGHT CALLS.
 *
 * Six registers and two forgets, because a mixed document is the reported
 * shape: a forget rewrites the whole map too, so it can drop a sibling's
 * registration just as a register can.
 */
test("🛑 eight concurrent registration writers all land, with nothing lost", async () => {
  const home = mkdtempSync(join(tmpdir(), "chat-mcp-reg-race-"));
  const kept = [0, 1, 2, 3, 4, 5].map((i) => `keeper-${i}`);
  const dropped = [0, 1].map((i) => `goner-${i}`);

  await race(home, [
    ...kept.map((handle) => ({ mode: "register" as const, handle })),
    ...dropped.map((handle) => ({ mode: "forget" as const, handle })),
  ]);

  const agents = onDisk(join(home, "agents.json")).agents ?? {};

  const lost = kept.filter((h) => agents[h] === undefined);
  const resurrected = dropped.filter((h) => agents[h] !== undefined);

  assert.deepEqual(lost, [], "registrations were silently lost");
  assert.deepEqual(resurrected, [], "a forgotten handle came back");

  assert.deepEqual(
    leftovers(home),
    [],
    "a lock or a staging file outlived the writers",
  );
});

/* ==========================================================================
 * The lock's own behaviour, in process.
 * ======================================================================= */

const { registerAgent, unregisterAgent, readRegistrations } =
  await import("../../src/supervise/registrations.js");
const { withFileLock } = await import("../../src/util/file-lock.js");

const HOME = process.env.CHAT_MCP_HOME;
const AGENTS = join(HOME, "agents.json");
const LOCK = `${AGENTS}.lock`;

/**
 * ⚠️ THE CONTROL FOR THE LOCK BEING RELEASED, not merely taken.
 *
 * A lock that was never released satisfies a single write and then deadlocks
 * the next one, so this asserts a SECOND write lands too. Without it, the race
 * test above would still pass and every later call would throw.
 */
test("⚠️ control — one writer alone writes, twice, leaving no lock", () => {
  registerAgent("solo", { vendor: "claude", mode: "host" });
  registerAgent("solo-two", { vendor: "claude", mode: "docker" });

  const { agents } = readRegistrations();

  assert.equal(agents["solo"]?.mode, "host");
  assert.equal(
    agents["solo-two"]?.mode,
    "docker",
    "the second write deadlocked",
  );
  assert.equal(existsSync(LOCK), false, "the lock outlived the write");
});

/**
 * ⚠️ A FORGET IS A WRITER TOO, and it takes the same lock.
 *
 * `unregisterAgent` returns early when the handle is absent, so this asserts
 * the path that actually writes rather than the one that returns.
 */
test("⚠️ control — a forget takes and releases the lock as well", () => {
  registerAgent("doomed", { vendor: "claude", mode: "host" });
  unregisterAgent("doomed");

  assert.equal(readRegistrations().agents["doomed"], undefined);
  assert.equal(existsSync(LOCK), false, "the lock outlived the forget");
});

/**
 * 🛑 A THROW INSIDE THE CRITICAL SECTION MUST LEAVE NO LOCK BEHIND.
 *
 * A lock left by a throwing writer bricks every later write for the whole
 * wait budget and then throws a timeout naming a live process — the most
 * misleading error this code can produce.
 *
 * ⚠️ THIS DRIVES `withFileLock` DIRECTLY, AND THE FIRST CUT DID NOT.
 * It went through `registerAgent` with an unserialisable `mode`, which
 * `parseRecord` rejects BEFORE the lock is taken — so the lock was never held
 * and the assertion could not fail. MEASURED: moving `release` out of the
 * `finally` left all four tests green.
 */
test("🛑 a throw inside the lock releases it", () => {
  const path = join(HOME, "throw-probe.lock");

  assert.throws(
    () =>
      withFileLock(path, () => {
        throw new Error("boom");
      }),
    /boom/,
  );

  assert.equal(existsSync(path), false, "a throwing section left its lock");

  // The positive half: the lock is reusable, not merely absent.
  assert.equal(
    withFileLock(path, () => "taken again"),
    "taken again",
  );
  assert.equal(existsSync(path), false);
});
