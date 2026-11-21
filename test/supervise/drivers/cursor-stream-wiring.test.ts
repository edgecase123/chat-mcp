import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { wireAgentChild } from "../../../src/supervise/drivers/wiring.js";
import { routeCursorEvent } from "../../../src/supervise/drivers/cursor.js";
import { cursorSpawn } from "../../../src/adapters/cursor-spawn.js";

/**
 * One real `cursor-agent` turn, replayed through the wiring the supervisor
 * actually uses.
 *
 * 🛑 EVERY OTHER CURSOR TEST CALLS `routeCursorEvent` DIRECTLY, with a
 * hand-written recorder. So the router is covered and the SEAM BELOW IT is
 * not: `fanout.ts`'s session dedupe is pinned by `wiring.test.ts`, which
 * passes `routeClaudeEvent` and nothing else. Found by claude1 on PR 345.
 *
 * 🛑 CURSOR IS THE VENDOR WHERE THAT DEDUPE EARNS ITS KEEP. Claude Code
 * carries the session id on a few events; cursor-agent repeats it on ALL 16 of
 * them, so an undeduped fanout reports the same id sixteen times and a
 * subscriber counting sessions counts turns.
 */
const STREAM = readFileSync(
  fileURLToPath(
    new URL(
      "../../support/fixtures/cursor-agent-one-turn.jsonl",
      import.meta.url,
    ),
  ),
  "utf8",
);

/** The id the fixture carries, named once so no assertion restates it. */
const SESSION_ID = "2fb62aea-5657-4e6d-a70c-07d35e831a27";

function fakeProcess() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();

  return {
    stdout,
    stderr,
    stdin,
    on() {},
    kill() {},
  };
}

function replay() {
  const proc = fakeProcess();
  const agent = wireAgentChild(proc as never, {
    routeEvent: routeCursorEvent,
    encodeInput: cursorSpawn.encodeInput,
    reportsUsage: cursorSpawn.reportsUsage,
    reportsContext: cursorSpawn.reportsContext,
  });

  const sessions: string[] = [];
  let ends = 0;
  const usage: unknown[] = [];

  agent.onSession((id) => sessions.push(id));
  agent.onTurnEnd(() => (ends += 1));
  agent.onUsage((s) => usage.push(s));

  return { proc, sessions, usage, ends: () => ends };
}

/**
 * 🛑 THE DENOMINATOR. A fixture this test could not read, or a stream the
 * line splitter silently dropped, would make every assertion below vacuous by
 * delivering nothing at all.
 */
test("the fixture is 16 events, all carrying the session id, only the result carrying usage", () => {
  const lines = STREAM.trim().split("\n");

  assert.equal(lines.length, 16, "the captured turn is 16 events");

  const events = lines.map(
    (line) => JSON.parse(line) as Record<string, unknown>,
  );

  for (const [i, event] of events.entries()) {
    assert.equal(
      event.session_id,
      SESSION_ID,
      `event ${i} (${String(event.type)}) must carry the id`,
    );
  }

  // Which event carries `usage` is a PREMISE of the absence test below, whose
  // delivery floor reads the turn end. A fixture that moved the payload onto a
  // non-terminal event would leave that floor asserting the wrong arrival.
  assert.deepEqual(
    events.filter((e) => e.usage !== undefined).map((e) => String(e.type)),
    ["result"],
    "the result event is the only event carrying usage",
  );
});

test("🛑 a 16-event turn reports the session ONCE and the turn end ONCE", async () => {
  const r = replay();

  r.proc.stdout.write(STREAM);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(r.sessions, [SESSION_ID], "16 events, one session report");
  assert.equal(r.ends(), 1, "only the result event ends the turn");
});

/**
 * 🔴 #219's SHAPE, ON REAL DATA. The fixture's result event carries a populated
 * `usage` object, so a router that "helpfully" forwarded it is caught here
 * against a real payload rather than a hand-made one.
 *
 * 🛑 THE CLAIM IS AN ABSENCE, SO IT NEEDS ITS OWN DELIVERY FLOOR. Test 1 guards
 * the FIXTURE and test 2 self-protects by asserting a non-empty value, but a
 * stream that never reached the router would satisfy `usage === []` on its own.
 * claude1 measured that on PR 350: deleting the write below left this test
 * green. The declaration itself is pinned by `cursor-vendor.test.ts`, not here.
 */
test("🔴 the real result event's usage object reaches no subscriber", async () => {
  const r = replay();

  r.proc.stdout.write(STREAM);
  await new Promise((resolve) => setImmediate(resolve));

  // The floor. `turnEnd` fires on the result event, which is the ONLY event
  // carrying `usage` — so this says the usage-bearing event was delivered
  // before the next line says its payload went nowhere.
  assert.equal(r.ends(), 1, "the usage-bearing result event was delivered");

  assert.deepEqual(r.usage, [], "token counts are not a RateLimitSnapshot");
});
