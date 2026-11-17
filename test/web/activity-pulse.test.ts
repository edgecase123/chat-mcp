import { test } from "node:test";
import assert from "node:assert/strict";
import {
  activityEvent,
  nextPulses,
  dotTitle,
  PULSE_FAILSAFE_MS,
} from "../../web/assets/logic.js";

/**
 * #240 — the browser half of the activity pulse. The supervisor already POSTs
 * and `server.ts` already fans out `event: activity`; nothing rendered it.
 *
 * 🛑 THESE ARE THE PURE HALVES ONLY. A green file here proves the decisions,
 * never that a listener is wired — `activity-wiring.test.ts` asserts that
 * against the source, for the reason `focus-search-wiring.test.ts` explains.
 */

// ── activityEvent: parsing a frame the page did not produce ──────────────

test("a tick frame parses to its handle and phase", () => {
  const e = activityEvent(
    JSON.stringify({ handle: "claude2-agent", phase: "tick", ts: 1 }),
  );

  assert.deepEqual(e, { handle: "claude2-agent", phase: "tick" });
});

test("an end frame parses", () => {
  assert.deepEqual(activityEvent('{"handle":"a","phase":"end"}'), {
    handle: "a",
    phase: "end",
  });
});

/**
 * 🛑 AN SSE HANDLER THAT THROWS KILLS NOTHING VISIBLY AND STOPS UPDATING.
 * EventSource does not reconnect on a listener exception, so one malformed
 * frame would freeze the pulse for the rest of the page's life.
 */
test("malformed JSON yields null rather than throwing", () => {
  assert.equal(activityEvent("not json"), null);
  assert.equal(activityEvent(""), null);
  assert.equal(activityEvent("[]"), null);
  assert.equal(activityEvent("null"), null);
});

test("a frame missing its handle yields null", () => {
  assert.equal(activityEvent('{"phase":"tick"}'), null);
  assert.equal(activityEvent('{"handle":"","phase":"tick"}'), null);
  assert.equal(activityEvent('{"handle":42,"phase":"tick"}'), null);
});

/**
 * The server validates `phase` itself — `server.ts` rejects anything but
 * `tick` or `end` — so this is defence in depth
 * against a future sender — but a phase this file does not know must not land
 * as a third state.
 */
test("an unknown phase yields null", () => {
  assert.equal(activityEvent('{"handle":"a","phase":"start"}'), null);
  assert.equal(activityEvent('{"handle":"a"}'), null);
});

// ── nextPulses: the reducer ──────────────────────────────────────────────

test("a tick marks the handle as working", () => {
  const next = nextPulses(new Set(), { handle: "a", phase: "tick" });

  assert.deepEqual([...next], ["a"]);
});

test("an end clears it", () => {
  const next = nextPulses(new Set(["a", "b"]), { handle: "a", phase: "end" });

  assert.deepEqual([...next], ["b"]);
});

test("two handles pulse independently", () => {
  let s: Set<string> = new Set();
  s = nextPulses(s, { handle: "a", phase: "tick" });
  s = nextPulses(s, { handle: "b", phase: "tick" });
  s = nextPulses(s, { handle: "a", phase: "end" });

  assert.deepEqual([...s], ["b"]);
});

/**
 * 🛑 THE SAME REFERENCE IS THE "NOTHING CHANGED" SIGNAL. A tick arrives every
 * 250ms for the whole turn and all but the first are repeats. The caller skips
 * its DOM write on reference equality, so returning a fresh equal Set would
 * make the sidebar churn four times a second for no visible difference.
 */
test("a repeated tick returns the SAME set, not an equal copy", () => {
  const prev = new Set(["a"]);

  assert.equal(nextPulses(prev, { handle: "a", phase: "tick" }), prev);
});

test("an end for a handle that was not working returns the same set", () => {
  const prev = new Set(["a"]);

  assert.equal(nextPulses(prev, { handle: "b", phase: "end" }), prev);
});

test("a null event returns the same set", () => {
  const prev = new Set(["a"]);

  assert.equal(nextPulses(prev, null), prev);
});

/**
 * ⚠️ THE FAILSAFE IS 30s AND IT IS NOT THE NORMAL PATH. `onTurnEnd`, `onExit`
 * and `replaceChild` all send an `end`. This only has to outlast a child that
 * dies without reaching any of them. A short value would re-introduce the
 * mid-turn blackout decision 3 on #240 removed, because a single long `Bash`
 * emits no event for its whole duration.
 */
test("the failsafe outlasts a long silent tool call", () => {
  assert.equal(PULSE_FAILSAFE_MS, 30_000);
});

// ── dotTitle: the pulse's NON-VISUAL carrier ─────────────────────────────

/**
 * 🛑 ONLY THE WORKING STATE IS NAMED. lee, 2026-11-14: "no title". I argued for
 * naming all three and was overruled, so the consequence is deliberate: the
 * tooltip appears and disappears with the work, and hovering an idle agent
 * gives nothing.
 *
 * ⚠️ THIS ANSWERS WCAG 1.4.1 ONLY, AND I CLAIMED IT ANSWERED MORE. A title
 * stops the pulse being a second meaning carried in colour alone. It says
 * nothing about whether the motion can be stopped, which is 2.2.2 and lives in
 * `style.css`. Found by claude1.
 */
test("a working peer says so in words, not only in motion", () => {
  const title = dotTitle({ kind: "peer", working: true });

  assert.ok(title, "a working peer was given no title at all");
  assert.match(title, /working/i);
});

test("🛑 an idle peer is given no title at all", () => {
  assert.equal(dotTitle({ kind: "peer", working: false }), null);
});

/**
 * 🛑 ROOMS CARRY `data-handle` TOO, so this is not hypothetical. `renderSidebar`
 * passes a room NAME as `target`, and before `data-kind` scoped the lookup a
 * pulse naming `#mcp` reached the room row. Found by claude1.
 */
test("a room dot has no title, working or not", () => {
  assert.equal(dotTitle({ kind: "room", working: false }), null);
  assert.equal(dotTitle({ kind: "room", working: true }), null);
});

/**
 * ⚠️ A NEGATIVE CONTROL ON THE SIGNATURE. `online` was a parameter until lee's
 * ruling made it unreadable, and a stale caller still passing it must not
 * change the answer.
 */
test("an `online` flag a caller still passes changes nothing", () => {
  const withFlag = dotTitle({
    kind: "peer",
    working: true,
    online: false,
  } as never);

  assert.equal(withFlag, dotTitle({ kind: "peer", working: true }));
});
