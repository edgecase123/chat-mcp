import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// A type-only import is erased, so it resolves no state path at load time.
import type { ScriptRunner } from "../../src/supervise/run-script.js";

// 🛑 BEFORE any import that resolves a state path.
process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), "chat-mcp-cap-"));

const { registerProject } = await import("../../src/supervise/projects.js");
const { ensureManifestDir, manifestPathFor } =
  await import("../../src/util/paths.js");
const { runCommandFor } =
  await import("../../src/supervise/run-command-service.js");

/**
 * 🛑 THE CAP IS PER HANDLE, SO EVERY TEST NEEDS ITS OWN HANDLE. The counters
 * are module state, and a shared handle would make one test's in-flight work
 * the next one's queue.
 */
const handleFor = (name: string) => `cap-${name}-${process.pid}`;

function projectFor(handle: string): void {
  const dir = mkdtempSync(join(tmpdir(), "chat-mcp-cap-project-"));

  mkdirSync(join(dir, "scripts"), { recursive: true });

  const slow = join(dir, "scripts", "slow.sh");
  writeFileSync(slow, "#!/bin/sh\nexit 0\n");
  chmodSync(slow, 0o755);

  registerProject(handle, dir);
  ensureManifestDir();
  writeFileSync(
    manifestPathFor(handle),
    JSON.stringify({
      projectDir: dir,
      commands: [{ name: "slow", script: "scripts/slow.sh", params: [] }],
    }),
  );
}

/**
 * A runner that never finishes on its own. `started` counts how many reached
 * it, which is the only thing that distinguishes "throttled" from "slow".
 */
function heldRunner() {
  const finish: (() => void)[] = [];
  let started = 0;

  const run = ((_f, _a, _o, cb) => {
    started += 1;
    finish.push(() => cb(null, "", ""));
  }) as ScriptRunner;

  return {
    run,
    get started() {
      return started;
    },
    releaseOne: () => finish.shift()?.(),
  };
}

/** Lets every already-queued microtask and timer turn run. */
const settle = () => new Promise((r) => setTimeout(r, 10));

// ---------------------------------------------------------------------------
// The claim lee approved. Without this one the suite passes on a GLOBAL cap.
// ---------------------------------------------------------------------------

test("🚨 TWO DIFFERENT HANDLES DO NOT BLOCK EACH OTHER, which is what per-handle MEANS", async () => {
  const a = handleFor("two-a");
  const b = handleFor("two-b");

  projectFor(a);
  projectFor(b);

  const runner = heldRunner();

  const first = runCommandFor(
    a,
    "slow",
    {},
    { maxConcurrent: 1, run: runner.run },
  );
  const second = runCommandFor(
    b,
    "slow",
    {},
    { maxConcurrent: 1, run: runner.run },
  );

  await settle();

  assert.equal(
    runner.started,
    2,
    "one handle held the other handle out of its own slot",
  );

  runner.releaseOne();
  runner.releaseOne();
  await Promise.all([first, second]);
});

test("🛑 A SECOND COMMAND FOR THE SAME HANDLE WAITS, and starts only once the first ends", async () => {
  const handle = handleFor("same");

  projectFor(handle);

  const runner = heldRunner();

  const first = runCommandFor(
    handle,
    "slow",
    {},
    { maxConcurrent: 1, run: runner.run },
  );
  const second = runCommandFor(
    handle,
    "slow",
    {},
    { maxConcurrent: 1, run: runner.run },
  );

  await settle();

  // The claim is that the second never REACHED the runner, not that it is slow.
  assert.equal(runner.started, 1, "the cap let a second command start");

  runner.releaseOne();
  await first;
  await settle();

  assert.equal(
    runner.started,
    2,
    "the waiter was never woken when the slot freed",
  );

  runner.releaseOne();
  await second;
});

test("a cap of 3 lets 3 start and holds the 4th", async () => {
  const handle = handleFor("three");

  projectFor(handle);

  const runner = heldRunner();
  const all = [0, 1, 2, 3].map(() =>
    runCommandFor(handle, "slow", {}, { maxConcurrent: 3, run: runner.run }),
  );

  await settle();

  assert.equal(runner.started, 3);

  for (const _ of all) runner.releaseOne();
  await settle();
  runner.releaseOne();
  await Promise.all(all);
});

// ---------------------------------------------------------------------------
// The slot has to come back on every ending, not just the happy one
// ---------------------------------------------------------------------------

test("🛑 A FAILED COMMAND RETURNS ITS SLOT, so one failure does not wedge the handle", async () => {
  const handle = handleFor("failed");

  projectFor(handle);

  const boom = ((_f, _a, _o, cb) => {
    cb(Object.assign(new Error("killed"), { killed: true }), "", "");
  }) as ScriptRunner;

  await assert.rejects(
    runCommandFor(handle, "slow", {}, { maxConcurrent: 1, run: boom }),
  );

  // Would hang rather than fail if the permit leaked, so the assertion is that
  // this resolves at all.
  const runner = heldRunner();
  const next = runCommandFor(
    handle,
    "slow",
    {},
    { maxConcurrent: 1, run: runner.run },
  );

  await settle();

  assert.equal(
    runner.started,
    1,
    "the failed command never gave its slot back",
  );

  runner.releaseOne();
  await next;
});

test("🛑 A REFUSED NAME TAKES NO SLOT AT ALL, so it never queues behind running work", async () => {
  const handle = handleFor("refused");

  projectFor(handle);

  const runner = heldRunner();
  const held = runCommandFor(
    handle,
    "slow",
    {},
    { maxConcurrent: 1, run: runner.run },
  );

  await settle();

  // The slot is occupied. A bad name must still be refused immediately rather
  // than waiting for it.
  await assert.rejects(
    runCommandFor(
      handle,
      "no-such-command",
      {},
      { maxConcurrent: 1, run: runner.run },
    ),
    /no command/,
  );

  runner.releaseOne();
  await held;
});

test("a cap below 1 is read as 1 rather than waiting forever", async () => {
  const handle = handleFor("zero");

  projectFor(handle);

  const runner = heldRunner();
  const only = runCommandFor(
    handle,
    "slow",
    {},
    { maxConcurrent: 0, run: runner.run },
  );

  await settle();

  assert.equal(
    runner.started,
    1,
    "a cap of 0 deadlocked instead of clamping to 1",
  );

  runner.releaseOne();
  await only;
});

// ---------------------------------------------------------------------------
// limits.json — the cap an operator sets, and what it does to a parked command
// ---------------------------------------------------------------------------

const limitsFile = join(process.env.CHAT_MCP_HOME as string, "limits.json");

/** Writes `limits.json` and removes it again, so no other test inherits it. */
function withLimits(
  t: { after: (fn: () => void) => void },
  body: unknown,
): void {
  writeFileSync(limitsFile, JSON.stringify(body));
  t.after(() => rmSync(limitsFile, { force: true }));
}

test("🛑 AN EXPLICIT OPTION BEATS THE FILE, so the 11 tests above still pin what they claim", async (t) => {
  const handle = handleFor("opt-wins");

  projectFor(handle);
  withLimits(t, { maxConcurrent: 1 });

  const runner = heldRunner();

  const first = runCommandFor(
    handle,
    "slow",
    {},
    { maxConcurrent: 3, run: runner.run },
  );
  const second = runCommandFor(
    handle,
    "slow",
    {},
    { maxConcurrent: 3, run: runner.run },
  );

  await settle();

  assert.equal(
    runner.started,
    2,
    "the file's cap of 1 overrode an explicit option of 3",
  );

  runner.releaseOne();
  runner.releaseOne();
  await Promise.all([first, second]);
});

test("⚠️ control — with NO option the file's cap really does bind, so the test above is not vacuous", async (t) => {
  const handle = handleFor("file-binds");

  projectFor(handle);
  withLimits(t, { maxConcurrent: 1 });

  const runner = heldRunner();

  const first = runCommandFor(handle, "slow", {}, { run: runner.run });
  const second = runCommandFor(handle, "slow", {}, { run: runner.run });

  await settle();

  assert.equal(
    runner.started,
    1,
    "the file was ignored and both commands started",
  );

  runner.releaseOne();
  await settle();
  runner.releaseOne();
  await Promise.all([first, second]);
});

/**
 * 🛑 THE LIMIT IS RESOLVED ONCE, BEFORE ANY WAIT. `acquireSlot` takes a number,
 * so a parked command keeps the limit it arrived with.
 *
 * 🛑 THE FILE IS LOWERED, NOT RAISED, AND THAT IS THE WHOLE TEST. Nothing wakes
 * a parked waiter until a slot frees, so RAISING the limit cannot distinguish a
 * frozen limit from a live one — both let the waiter through. Only lowering it
 * does: a live limit makes the woken waiter re-park.
 */
test("🛑 A PARKED COMMAND KEEPS THE LIMIT IT ARRIVED WITH, even if the file is LOWERED", async (t) => {
  const handle = handleFor("frozen");

  projectFor(handle);
  withLimits(t, { maxConcurrent: 2 });

  const runner = heldRunner();

  const first = runCommandFor(handle, "slow", {}, { run: runner.run });
  const second = runCommandFor(handle, "slow", {}, { run: runner.run });
  const third = runCommandFor(handle, "slow", {}, { run: runner.run });

  await settle();
  assert.equal(runner.started, 2, "the cap of 2 did not hold");

  // One slot frees, so the parked third wakes and re-checks. Its own limit is
  // 2 and one command is left running, so it must start.
  writeFileSync(limitsFile, JSON.stringify({ maxConcurrent: 1 }));
  runner.releaseOne();
  await settle();

  assert.equal(
    runner.started,
    3,
    "the parked command re-checked against the NEW cap of 1 and stayed parked",
  );

  runner.releaseOne();
  runner.releaseOne();
  await Promise.all([first, second, third]);
});

test("🛑 AN UNREADABLE limits.json REFUSES THE COMMAND rather than running it uncapped", async (t) => {
  const handle = handleFor("bad-file");

  projectFor(handle);
  writeFileSync(limitsFile, '{ "maxConcurrent": 1,, }');
  t.after(() => rmSync(limitsFile, { force: true }));

  const runner = heldRunner();

  // 🛑 THE PUBLIC MESSAGE MUST NOT NAME THE PATH. `limits.json` sits inside the
  // state directory, which the container boundary exists to hide, and the
  // caller here is the agent. The path rides in `detail`, for the host's log.
  await assert.rejects(
    () => runCommandFor(handle, "slow", {}, { run: runner.run }),
    (err: Error & { detail?: string }) =>
      err.name === "Refusal" &&
      !err.message.includes(limitsFile) &&
      !err.message.includes("/") &&
      err.detail !== undefined &&
      err.detail.includes(limitsFile),
  );

  assert.equal(
    runner.started,
    0,
    "the script ran despite an unreadable limits file",
  );
});
