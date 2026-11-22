import { existsSync, writeFileSync } from "node:fs";

import { buildImage, markConfirmed } from "../../../src/supervise/container.js";
import { buildConfirmPlan } from "../../../src/supervise/confirmPlan.js";
import { claudeSpawn } from "../../../src/adapters/claude-spawn.js";

/**
 * One real writer of `container.json`, run as its own process.
 *
 * 🛑 A SEPARATE PROCESS IS THE WHOLE POINT. Two calls in sequence inside one
 * test prove the merge logic and say nothing about a lost update — the race
 * this fixture exists to drive needs two OS processes contending for the file.
 *
 * 🛑 IT BLOCKS ON A BARRIER THE PARENT CREATES LAST, so the window is
 * CONSTRUCTED rather than sampled. Raising a child count until a race shows up
 * tunes the test to one laptop, which is #398's shape.
 *
 * argv: <mode: confirm|build> <key> <readyPath> <barrierPath>
 */
const [mode, key, readyPath, barrierPath] = process.argv.slice(2);

/** A no-op `docker build`. This fixture races the state write, not docker. */
const noBuild = () => Buffer.alloc(0);

/**
 * Pause without yielding, matching the production lock's own sleep.
 *
 * Every call below it is synchronous, so there is no event loop to await on.
 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 🛑 EVERYTHING SLOW IS DONE BEFORE THE BARRIER, so the write is all that the
 * barrier releases.
 *
 * `buildImage` hashes `dist`, which walks the tree. Left until after the
 * barrier it staggers the children by however long each walk takes, and the
 * simultaneity the barrier bought is spent.
 *
 * ⚠️ THE WARM-UP WRITES A DIFFERENT KEY ON PURPOSE. Warming with `key` itself
 * would leave the value already on disk, and a lost update after the barrier
 * would then be invisible to the parent's assertion.
 */
if (mode === "confirm") buildConfirmPlan(claudeSpawn, key);
else buildImage(noBuild, { image: `${key}-warmup`, vendor: "claude" });

writeFileSync(readyPath, `${process.pid}\n`);

// ⚠️ BOUNDED, because a parent that dies before creating the barrier would
// otherwise leave this process running after the test has finished.
const deadline = Date.now() + 30_000;

while (!existsSync(barrierPath)) {
  if (Date.now() >= deadline) {
    throw new Error(`barrier ${barrierPath} never appeared`);
  }
  sleepSync(1);
}

if (mode === "confirm") markConfirmed(key, buildConfirmPlan(claudeSpawn, key));
else buildImage(noBuild, { image: key, vendor: "claude" });
