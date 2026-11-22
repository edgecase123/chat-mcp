import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// 🛑 BEFORE any import that resolves a state path.
process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), "chat-mcp-state-lock-"));

const { markConfirmed } = await import("../../src/supervise/container.js");

import type { ContainerPlan } from "../../src/supervise/container.js";
import { deadPid } from "../support/dead-pid.js";

/**
 * #377 — `container.json` was a read-modify-write with no lock.
 *
 * 🛑 THE CONSEQUENCE IS A SILENTLY LOST APPROVAL. The operator clicks
 * **Approve plan**, the card reports success, and a concurrent `buildImage`
 * writes back the state it read before that approval landed. The handle then
 * refuses to start while the card still shows it approved.
 *
 * 🛑 THE WORSE DIRECTION IS `builtHash`. A lost one makes `imageNeedsBuild`
 * report a stale image as current, which is the defect `prepareAgentImage`'s
 * docblock already describes: a container up on a `dist` with no HTTP bus in
 * it, and `agents start` answering nothing.
 *
 * `POST /api/agents/confirm` (#132 slice 4b) is the first caller that can run
 * while a supervisor is up, which is what made the window reachable.
 */

const HOME = process.env.CHAT_MCP_HOME;
const STATE = join(HOME, "container.json");
const LOCK = `${STATE}.lock`;

/** The repo root, so a spawned child resolves the fixture and its imports. */
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const FIXTURE = "test/support/fixtures/container-state-writer.ts";

function plan(over: Partial<ContainerPlan> = {}): ContainerPlan {
  return {
    mountPaths: ["/work"],
    envVarNames: ["CLAUDE_CODE_OAUTH_TOKEN"],
    envValuesDigest: "0".repeat(64),
    binary: "claude",
    networkMode: "bridge",
    image: "chat-mcp-agent:local",
    memory: null,
    cpus: null,
    installMemory: null,
    installCpus: null,
    ...over,
  };
}

/** Whatever is on disk right now, or the empty shape if nothing is. */
function onDisk(path = STATE): {
  builtHashes?: Record<string, string>;
  confirmed?: Record<string, unknown>;
} {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Every leftover beside the state file: a held lock, a staging file. */
function leftovers(dir = HOME): string[] {
  return readdirSync(dir).filter((f) => f.startsWith("container.json."));
}

/* ==========================================================================
 * The race, driven by real processes.
 * ======================================================================= */

/**
 * Run `writers` as separate processes that all enter the write window at once.
 *
 * 🛑 THE BARRIER IS CREATED LAST, AFTER EVERY CHILD HAS SAID IT IS READY.
 * Spawning eight children and hoping they overlap samples the race; this
 * constructs it, so the lock-removed control below fails on purpose rather
 * than on luck.
 */
async function race(
  home: string,
  writers: readonly { mode: "confirm" | "build"; key: string }[],
): Promise<void> {
  const barrier = join(home, "barrier");
  const ready = writers.map((_, i) => join(home, `ready-${i}`));

  const children = writers.map((writer, i) =>
    spawn(
      process.execPath,
      ["--import", "tsx", FIXTURE, writer.mode, writer.key, ready[i], barrier],
      {
        cwd: REPO_ROOT,
        // ⚠️ `CHAT_MCP_HOME` IS PASSED EXPLICITLY. A child inherits
        // `NODE_TEST_CONTEXT`, so `stateDir()` refuses rather than resolving
        // the operator's live `~/.chat-mcp`. `paths.ts` names this case.
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
                  `writer ${i} (${writers[i].key}) exited ${code}\n${stderr}`,
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
 * 🛑 EIGHT REAL PROCESSES, NOT EIGHT CALLS. The ticket's own bar: a test that
 * interleaves by hand proves the merge logic and says nothing about a lost
 * update.
 *
 * Four approvals and four image hashes, because that pairing is the reported
 * defect — an approval lost to a concurrent build.
 */
test("🛑 eight concurrent writers all land, with nothing lost", async () => {
  const home = mkdtempSync(join(tmpdir(), "chat-mcp-state-race-"));
  const handles = [0, 1, 2, 3].map((i) => `racer-${i}`);
  const images = [0, 1, 2, 3].map((i) => `chat-mcp-race-${i}:local`);

  await race(home, [
    ...handles.map((key) => ({ mode: "confirm" as const, key })),
    ...images.map((key) => ({ mode: "build" as const, key })),
  ]);

  const state = onDisk(join(home, "container.json"));

  const lostApprovals = handles.filter((h) => !state.confirmed?.[h]);
  const lostHashes = images.filter((i) => !state.builtHashes?.[i]);

  assert.deepEqual(lostApprovals, [], "approvals were silently lost");
  assert.deepEqual(lostHashes, [], "builtHash writes were silently lost");

  assert.deepEqual(
    leftovers(home),
    [],
    "a lock or a staging file outlived the writers",
  );
});

/* ==========================================================================
 * The lock's own behaviour, in process.
 * ======================================================================= */

/**
 * ⚠️ THE CONTROL FOR THE LOCK BEING RELEASED, not merely taken. A lock that
 * was never released would satisfy a single write and then deadlock the next
 * one, so this asserts the second write too.
 */
test("⚠️ control — one writer alone writes, twice, leaving no lock", () => {
  markConfirmed("solo", plan());
  assert.ok(onDisk().confirmed?.solo, "the first write did not land");

  markConfirmed("solo-again", plan());
  assert.ok(
    onDisk().confirmed?.["solo-again"],
    "the second write did not land",
  );

  assert.deepEqual(leftovers(), [], "the lock was not released");
});

/**
 * 🛑 A DEAD HOLDER IS BROKEN IMMEDIATELY, NOT WAITED OUT. A `SIGKILL`ed
 * supervisor leaves its lock behind, and a lock that only ever expires on a
 * timer bricks every spawn until a human deletes a file.
 */
test("🛑 a lock held by a dead process is broken", () => {
  const dead = deadPid();

  // The premise, asserted rather than assumed — `dead-pid.ts` explains why.
  assert.ok(dead > 0);

  writeFileSync(LOCK, `${dead}\n`);

  markConfirmed("after-dead-holder", plan());

  assert.ok(
    onDisk().confirmed?.["after-dead-holder"],
    "a dead holder's lock blocked the write",
  );
  assert.deepEqual(leftovers(), [], "the broken lock was not cleaned up");
});

/**
 * 🛑 THE CONTROL THAT MAKES THE ONE ABOVE MEAN ANYTHING. A lock broken
 * unconditionally would pass it and would reintroduce #377 — two writers would
 * simply take turns stealing each other's lock.
 *
 * This process is alive, so its own pid in the lock must be waited for and
 * then refused.
 */
test("🛑 a lock held by a LIVE process is refused, not stolen", () => {
  writeFileSync(LOCK, `${process.pid}\n`);

  const before = readFileSync(STATE, "utf8");

  assert.throws(
    () => markConfirmed("should-not-land", plan()),
    /waiting for .*container\.json\.lock/,
  );

  assert.equal(readFileSync(STATE, "utf8"), before, "the state was written");
  assert.equal(
    readFileSync(LOCK, "utf8").trim(),
    String(process.pid),
    "the live holder's lock was overwritten",
  );

  // 🛑 REMOVED, NOT BLANKED. An empty lock is a LIVE holder by design, so
  // leaving one here would time out every test below instead of this one.
  rmSync(LOCK, { force: true });
});

/**
 * 🛑 AN EMPTY LOCK READS AS LIVE, AND THAT IS NOT AN OVERSIGHT. Creating the
 * file and writing the pid into it are one call today, but a reader can still
 * catch a lock whose bytes have not landed. Treating empty as DEAD lets two
 * processes break each other's fresh locks, which is a slower #377.
 *
 * Raised by claude1 reviewing the plan, before the code existed.
 */
test("🛑 an empty lock file is treated as a live holder", () => {
  writeFileSync(LOCK, "");

  assert.throws(
    () => markConfirmed("empty-lock", plan()),
    /waiting for .*container\.json\.lock/,
  );

  writeFileSync(LOCK, "not-a-pid");

  assert.throws(
    () => markConfirmed("junk-lock", plan()),
    /waiting for .*container\.json\.lock/,
  );

  rmSync(LOCK, { force: true });
});

/**
 * ⚠️ THE `finally` RELEASES THE LOCK, proven by making the mutator throw.
 *
 * A `BigInt` is the cheapest way in: `JSON.stringify` refuses to serialise
 * one, and it refuses while the lock is held.
 *
 * 🛑 IT PROVES NOTHING ABOUT THE STAGING FILE, AND SAYING SO IS THE POINT.
 * The throw happens while the staging file's CONTENTS are being computed, so
 * no staging file is ever created. Deleting that half of the `finally` kept
 * this test green — measured, which is how the next test came to exist.
 */
test("⚠️ a throw while serialising releases the lock", () => {
  const unserialisable = plan({
    binary: 1n as unknown as string,
  });

  assert.throws(() => markConfirmed("doomed", unserialisable), TypeError);

  assert.deepEqual(leftovers(), [], "a throw left a lock behind");

  // And the next writer is not blocked by the wreckage.
  markConfirmed("after-the-throw", plan());
  assert.ok(onDisk().confirmed?.["after-the-throw"]);
});

/**
 * ⚠️ THE STAGING HALF OF THE `finally`, which needs a throw that lands AFTER
 * the staging file exists.
 *
 * `renameSync` onto a DIRECTORY is the one reachable failure in that window.
 * The read falls back to the empty state, the staging file is written, and the
 * rename then throws with the staging file sitting on disk.
 *
 * 🛑 THE TEST ABOVE CANNOT REACH THIS. Its throw precedes the staging write,
 * so removing `rmSync(staging)` left it green.
 */
test("⚠️ a throw after staging leaves no staging file behind", () => {
  rmSync(STATE, { force: true });
  mkdirSync(STATE);

  try {
    assert.throws(() => markConfirmed("doomed-at-rename", plan()));

    assert.deepEqual(
      leftovers(),
      [],
      "a failed rename left a staging file or a lock behind",
    );
  } finally {
    rmSync(STATE, { recursive: true, force: true });
  }

  // The directory is gone, so an ordinary write works again.
  markConfirmed("after-the-rename-failure", plan());
  assert.ok(onDisk().confirmed?.["after-the-rename-failure"]);
});
