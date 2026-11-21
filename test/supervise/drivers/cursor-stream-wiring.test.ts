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
test("the fixture is a 16-event stream and every event carries the session id", () => {
  const lines = STREAM.trim().split("\n");

  assert.equal(lines.length, 16, "the captured turn is 16 events");

  for (const [i, line] of lines.entries()) {
    const event = JSON.parse(line) as Record<string, unknown>;
    assert.equal(
      event.session_id,
      SESSION_ID,
      `event ${i} (${String(event.type)}) must carry the id`,
    );
  }
});

test("🛑 a 16-event turn reports the session ONCE and the turn end ONCE", async () => {
  const r = replay();

  r.proc.stdout.write(STREAM);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(r.sessions, [SESSION_ID], "16 events, one session report");
  assert.equal(r.ends(), 1, "only the result event ends the turn");
});

/**
 * 🔴 #219's SHAPE, ON REAL DATA. `cursorSpawn` declares `reportsUsage: false`,
 * and the fixture's result event carries a populated `usage` object — so this
 * is the one case where a router that "helpfully" forwarded it would be caught
 * against the declaration rather than against a hand-made payload.
 */
test("🔴 the real result event's usage object reaches no subscriber", async () => {
  const r = replay();

  r.proc.stdout.write(STREAM);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(cursorSpawn.reportsUsage, false);
  assert.deepEqual(r.usage, [], "token counts are not a RateLimitSnapshot");
});
