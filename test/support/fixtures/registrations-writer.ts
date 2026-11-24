import { existsSync, writeFileSync } from "node:fs";

import {
  registerAgent,
  unregisterAgent,
} from "../../../src/supervise/registrations.js";

/**
 * One real writer of `agents.json`, run as its own process.
 *
 * 🛑 A SEPARATE PROCESS IS THE WHOLE POINT. Two calls in sequence inside one
 * test prove the merge logic and say nothing about a lost update. Mirrors
 * `container-state-writer.ts`, which drives the same race one file over.
 *
 * 🛑 IT BLOCKS ON A BARRIER THE PARENT CREATES LAST, so the window is
 * CONSTRUCTED rather than sampled. Raising a child count until a race appears
 * tunes the test to one laptop, which is #398's shape.
 *
 * argv: <mode: register|forget> <handle> <readyPath> <barrierPath>
 */
const [mode, handle, readyPath, barrierPath] = process.argv.slice(2);

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 🛑 A `forget` WRITER REGISTERS ITS VICTIM BEFORE THE BARRIER.
 *
 * `unregisterAgent` returns without writing when the handle is absent, so a
 * forget racer with nothing to forget is not a writer at all and the race
 * would be four contenders rather than eight.
 */
if (mode === "forget")
  registerAgent(handle, { vendor: "claude", mode: "host" });

writeFileSync(readyPath, `${process.pid}\n`);

// ⚠️ BOUNDED, so a parent that dies before the barrier leaves nothing running.
const deadline = Date.now() + 30_000;

while (!existsSync(barrierPath)) {
  if (Date.now() >= deadline) {
    throw new Error(`barrier ${barrierPath} never appeared`);
  }
  sleepSync(1);
}

if (mode === "register") {
  registerAgent(handle, { vendor: "claude", mode: "docker" });
} else {
  unregisterAgent(handle);
}
