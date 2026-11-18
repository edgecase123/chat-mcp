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
    { sandbox: "host", maxConcurrent: 1, run: runner.run },
  );
  const second = runCommandFor(
    b,
    "slow",
    {},
    { sandbox: "host", maxConcurrent: 1, run: runner.run },
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

test("🛑 A SECOND COMMAND FOR THE SAME HANDLE IS REFUSED, not queued behind the first", async () => {
  const handle = handleFor("same");

  projectFor(handle);

  const runner = heldRunner();

  const first = runCommandFor(
    handle,
    "slow",
    {},
    { sandbox: "host", maxConcurrent: 1, run: runner.run },
  );

  await settle();

  await assert.rejects(
    runCommandFor(
      handle,
      "slow",
      {},
      { sandbox: "host", maxConcurrent: 1, run: runner.run },
    ),
    /the command runner is busy; retry/,
    "the second command parked instead of being refused",
  );

  // The claim is that the refused one never REACHED the runner, not that it
  // was slow to get there.
  assert.equal(runner.started, 1, "the refused command started anyway");

  runner.releaseOne();
  await first;

  // 🛑 A REFUSAL MUST COST THE HANDLE NOTHING. A refusal that took a slot and
  // never released it would leave the cap permanently one lower, and the two
  // assertions above would both still pass.
  const third = runCommandFor(
    handle,
    "slow",
    {},
    { sandbox: "host", maxConcurrent: 1, run: runner.run },
  );

  await settle();

  assert.equal(runner.started, 2, "the slot never came back after a refusal");

  runner.releaseOne();
  await third;
});

test("a cap of 3 lets 3 start and refuses the 4th", async () => {
  const handle = handleFor("three");

  projectFor(handle);

  const runner = heldRunner();
  const all = [0, 1, 2].map(() =>
    runCommandFor(
      handle,
      "slow",
      {},
      { sandbox: "host", maxConcurrent: 3, run: runner.run },
    ),
  );

  await settle();

  assert.equal(runner.started, 3);

  await assert.rejects(
    runCommandFor(
      handle,
      "slow",
      {},
      { sandbox: "host", maxConcurrent: 3, run: runner.run },
    ),
    /the command runner is busy; retry/,
    "the 4th command parked instead of being refused",
  );

  assert.equal(runner.started, 3, "the refused 4th command reached the runner");

  for (const _ of all) runner.releaseOne();
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
    runCommandFor(
      handle,
      "slow",
      {},
      { sandbox: "host", maxConcurrent: 1, run: boom },
    ),
  );

  // Would hang rather than fail if the permit leaked, so the assertion is that
  // this resolves at all.
  const runner = heldRunner();
  const next = runCommandFor(
    handle,
    "slow",
    {},
    { sandbox: "host", maxConcurrent: 1, run: runner.run },
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
    { sandbox: "host", maxConcurrent: 1, run: runner.run },
  );

  await settle();

  // The slot is occupied. A bad name must still be refused immediately rather
  // than waiting for it.
  await assert.rejects(
    runCommandFor(
      handle,
      "no-such-command",
      {},
      { sandbox: "host", maxConcurrent: 1, run: runner.run },
    ),
    /no command/,
  );

  runner.releaseOne();
  await held;
});

test("a cap below 1 is read as 1, so one runs and the next is refused", async () => {
  const handle = handleFor("zero");

  projectFor(handle);

  const runner = heldRunner();
  const only = runCommandFor(
    handle,
    "slow",
    {},
    { sandbox: "host", maxConcurrent: 0, run: runner.run },
  );

  await settle();

  assert.equal(
    runner.started,
    1,
    "a cap of 0 refused the first command instead of clamping to 1",
  );

  // The other half of the clamp. A 0 read as 0 would refuse everything, which
  // is as useless as the deadlock this assertion used to guard against.
  await assert.rejects(
    runCommandFor(
      handle,
      "slow",
      {},
      { sandbox: "host", maxConcurrent: 0, run: runner.run },
    ),
    /the command runner is busy; retry/,
    "a cap of 0 was read as something above 1",
  );

  runner.releaseOne();
  await only;
});

// ---------------------------------------------------------------------------
// limits.json — the cap an operator sets, and when a change to it binds
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

test("🛑 AN EXPLICIT OPTION BEATS THE FILE, so every test above still pins what it claims", async (t) => {
  const handle = handleFor("opt-wins");

  projectFor(handle);
  withLimits(t, { maxConcurrent: 1 });

  const runner = heldRunner();

  const first = runCommandFor(
    handle,
    "slow",
    {},
    { sandbox: "host", maxConcurrent: 3, run: runner.run },
  );
  const second = runCommandFor(
    handle,
    "slow",
    {},
    { sandbox: "host", maxConcurrent: 3, run: runner.run },
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

  const first = runCommandFor(
    handle,
    "slow",
    {},
    { sandbox: "host", run: runner.run },
  );

  await settle();

  await assert.rejects(
    runCommandFor(handle, "slow", {}, { sandbox: "host", run: runner.run }),
    /the command runner is busy; retry/,
    "the file was ignored and a second command started",
  );

  assert.equal(runner.started, 1, "the refused command reached the runner");

  runner.releaseOne();
  await first;
});

/**
 * 🛑 THE FILE IS RAISED, NOT LOWERED, AND THAT IS THE WHOLE TEST. A lowered
 * file refuses at either cap, so lowering cannot tell a re-read from a number
 * cached at module load. Raising can: only a re-read lets the next command
 * through.
 *
 * This is what replaced the parked-command claim. Nothing parks, so a frozen
 * limit has no life to keep, and the live question became whether the refusal
 * reads the CURRENT file.
 */
test("🛑 A RAISED limits.json BINDS ON THE NEXT COMMAND, so a refusal reads the CURRENT file", async (t) => {
  const handle = handleFor("raised");

  projectFor(handle);
  withLimits(t, { maxConcurrent: 1 });

  const runner = heldRunner();

  const first = runCommandFor(
    handle,
    "slow",
    {},
    { sandbox: "host", run: runner.run },
  );

  await settle();
  assert.equal(runner.started, 1, "the cap of 1 did not let the first start");

  await assert.rejects(
    runCommandFor(handle, "slow", {}, { sandbox: "host", run: runner.run }),
    /the command runner is busy; retry/,
    "the cap of 1 did not refuse a second command",
  );

  writeFileSync(limitsFile, JSON.stringify({ maxConcurrent: 2 }));

  const second = runCommandFor(
    handle,
    "slow",
    {},
    { sandbox: "host", run: runner.run },
  );

  await settle();

  assert.equal(
    runner.started,
    2,
    "the raised cap was not read, so the limit was cached rather than per call",
  );

  runner.releaseOne();
  runner.releaseOne();
  await Promise.all([first, second]);
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
    () =>
      runCommandFor(handle, "slow", {}, { sandbox: "host", run: runner.run }),
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
