import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CURSOR_CONTEXT_WINDOWS,
  CURSOR_FALLBACK_CONTEXT_WINDOW,
  CURSOR_MODELS,
  contextWindowsByDisplayName,
  routeCursorEvent,
  smallestWindow,
} from "../../../src/supervise/drivers/cursor.js";
import type { ContextSnapshot } from "../../../src/supervise/context-gauge.js";
import type { RouterState } from "../../../src/supervise/vendor.js";

/**
 * The Cursor context gauge — #419.
 *
 * 🛑 THE MODEL AND THE COUNTS ARE ON TWO DIFFERENT EVENTS. `system init`
 * names the model; `result` carries the tokens. Every test here drives both,
 * through one state bag, because one event alone cannot make a reading.
 */

const INIT = (model: string) => ({
  type: "system",
  subtype: "init",
  session_id: "s",
  model,
});

/** A `result` whose usage is the live capture from `cursor-agent`. */
const RESULT = (usage: Record<string, number>) => ({
  type: "result",
  subtype: "success",
  session_id: "s",
  usage,
});

/** Drive a sequence of events through one bag, collecting every reading. */
function readingsFor(events: Record<string, unknown>[]): ContextSnapshot[] {
  const seen: ContextSnapshot[] = [];
  const state: RouterState = {};

  for (const event of events) {
    routeCursorEvent(
      event,
      {
        turnEnd: () => undefined,
        usage: () => undefined,
        context: (s) => seen.push(s),
      },
      state,
    );
  }

  return seen;
}

test("a pinned model resolves its window and the reading is not a fallback", () => {
  const [reading] = readingsFor([
    INIT("Composer 2.5 Fast"),
    RESULT({ inputTokens: 13918, cacheReadTokens: 3968 }),
  ]);

  assert.deepEqual(reading, {
    used: 17886,
    total: 200_000,
    model: "Composer 2.5 Fast",
    totalIsFallback: false,
  });
});

/**
 * 🔴 THE GAUGE RUNS BACKWARDS ON `inputTokens` ALONE. On a resumed turn the
 * earlier context moves into the cache, so `inputTokens` FALLS while the real
 * fill RISES. These are the two measured turns from #419.
 */
test("🔴 the numerator is the SUM, which RISES where inputTokens alone FALLS", () => {
  const first = readingsFor([
    INIT("Composer 2.5 Fast"),
    RESULT({ inputTokens: 13764, cacheReadTokens: 0 }),
  ])[0];
  const second = readingsFor([
    INIT("Composer 2.5 Fast"),
    RESULT({ inputTokens: 2490, cacheReadTokens: 15_600 }),
  ])[0];

  assert.ok(
    2490 < 13764,
    "the control: inputTokens alone FELL between these two turns",
  );
  assert.ok(
    second.used > first.used,
    "the sum must rise over a context that grew; this gauge runs backwards",
  );
});

/**
 * 🛑 THE CARRY-FORWARD FROM PR 424, AND THE WHOLE REASON THE BAG IS CLEARED.
 *
 * `per-turn.ts` holds ONE fan-out across every turn, so the bag outlives a
 * turn. A router that writes the model and never clears it reports the
 * previous turn's denominator as measured.
 */
test("🛑 a turn with NO init does not inherit the previous turn's model", () => {
  const readings = readingsFor([
    INIT("Composer 2.5 Fast"),
    RESULT({ inputTokens: 100, cacheReadTokens: 0 }),
    // Turn two. No init, which is the shape a dropped or partial turn has.
    RESULT({ inputTokens: 200, cacheReadTokens: 0 }),
  ]);

  assert.equal(readings.length, 2);
  assert.equal(
    readings[0].totalIsFallback,
    false,
    "the control: turn one resolved",
  );
  assert.equal(
    readings[1].model,
    null,
    "turn two inherited turn one's model, so its denominator is a guess reported as measured",
  );
  assert.equal(readings[1].totalIsFallback, true);
});

/**
 * 🛑 THE KEY IS THE DISPLAY NAME, NOT THE `--model` ID. A map keyed on
 * `composer-2.5-fast` matches nothing the stream ever reports.
 */
test("🛑 the --model id does NOT resolve; only the display name does", () => {
  const [byId] = readingsFor([
    INIT("composer-2.5-fast"),
    RESULT({ inputTokens: 10, cacheReadTokens: 0 }),
  ]);

  assert.equal(byId.totalIsFallback, true);
  assert.ok(
    Object.hasOwn(CURSOR_CONTEXT_WINDOWS, "Composer 2.5 Fast"),
    "the control: the display name IS the key",
  );
});

/** An `auto` handle reports the literal "Auto", which names no model. */
test("an auto handle gets a reading, with its denominator declared a fallback", () => {
  const [reading] = readingsFor([
    INIT("Auto"),
    RESULT({ inputTokens: 13918, cacheReadTokens: 3968 }),
  ]);

  assert.equal(reading.model, "Auto");
  assert.equal(reading.total, CURSOR_FALLBACK_CONTEXT_WINDOW);
  assert.equal(reading.totalIsFallback, true);
});

/**
 * 🛑 `Object.hasOwn`, NOT `windows[name] ?? fallback`. An inherited member is
 * not nullish, so this model name answered with a FUNCTION where a number was
 * promised — `totalIsFallback` false, nothing logged, the percentage NaN.
 */
test("🛑 a model named for an inherited member is UNMAPPED, not a function", () => {
  const [reading] = readingsFor([
    INIT("toString"),
    RESULT({ inputTokens: 10, cacheReadTokens: 0 }),
  ]);

  assert.equal(typeof reading.total, "number");
  assert.equal(reading.totalIsFallback, true);
});

/**
 * 🛑 THE DIRECTION, PINNED TODAY RATHER THAN AT THE SECOND MODEL.
 *
 * Over the real one-entry map `Math.min` and `Math.max` return the same
 * number, so a control against the const could not tell a correct derivation
 * from a reversed one. A passed map can carry two entries. Raised by claude1.
 */
test("🛑 the fallback is the SMALLEST window, not the largest", () => {
  assert.equal(smallestWindow({ small: 200_000, large: 1_000_000 }), 200_000);
  assert.notEqual(
    smallestWindow({ small: 200_000, large: 1_000_000 }),
    1_000_000,
    "a reversed derivation reads LOW, so no band fires as the agent fills",
  );
});

test("the real fallback is derived from the real map, never written as a literal", () => {
  assert.equal(
    CURSOR_FALLBACK_CONTEXT_WINDOW,
    smallestWindow(CURSOR_CONTEXT_WINDOWS),
  );
});

/**
 * 🛑 THE DIRECTION OF THE RE-KEY, PINNED OVER TWO ROWS. Over the real one-row
 * `CURSOR_MODELS`, keying on the id and keying on the display name both yield
 * a one-entry map, so a control against the const cannot discriminate them.
 * Two rows whose ids and display names all differ can. Same shape as the
 * `smallestWindow` test above.
 */
test("🛑 the window map is keyed on the DISPLAY NAME, never on the --model id", () => {
  const windows = contextWindowsByDisplayName({
    "composer-2.5-fast": { displayName: "Composer 2.5 Fast", window: 200_000 },
    "sonnet-4.5": { displayName: "Sonnet 4.5", window: 1_000_000 },
  });

  assert.deepEqual(windows, {
    "Composer 2.5 Fast": 200_000,
    "Sonnet 4.5": 1_000_000,
  });
  assert.equal(
    Object.hasOwn(windows, "composer-2.5-fast"),
    false,
    "an id-keyed map matches nothing the stream ever reports",
  );
});

test("the real window map is derived from the real table, never written out", () => {
  assert.deepEqual(
    CURSOR_CONTEXT_WINDOWS,
    contextWindowsByDisplayName(CURSOR_MODELS),
  );
});

test("a result with no usage produces no reading at all", () => {
  assert.deepEqual(
    readingsFor([
      INIT("Composer 2.5 Fast"),
      { type: "result", session_id: "s" },
    ]),
    [],
  );
});
