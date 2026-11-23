import { test } from "node:test";
import assert from "node:assert/strict";
import { createEventFanout } from "../../src/supervise/drivers/fanout.js";
import type { EventRouter } from "../../src/supervise/vendor.js";

/**
 * The seam that lets a vendor carry one fact from one event to a later one.
 *
 * 🛑 CURSOR NEEDS IT AND CLAUDE DOES NOT. Cursor names its model on
 * `system init` and its token counts on `result`, two different events, and
 * `routeCursorEvent` is a pure function. Claude's `message.model` rides beside
 * the usage on every assistant event, so its router never reads this argument.
 *
 * 🛑 MODULE STATE WAS THE ALTERNATIVE AND IT IS NOT VIABLE: two handles share
 * the module, so handle B would read handle A's model. That is the claim the
 * second test below pins.
 */

/** A router that counts the events it has seen IN ITS OWN BAG. */
const countingRouter: EventRouter = (_event, on, state) => {
  const seen = typeof state.seen === "number" ? state.seen : 0;

  state.seen = seen + 1;

  on.context?.({
    used: seen + 1,
    total: 100,
    model: null,
    totalIsFallback: true,
  });
};

/** Feed `n` events through one fan-out, returning each reported `used`. */
function countsAcross(fanout: ReturnType<typeof createEventFanout>, n: number) {
  const used: number[] = [];

  fanout.subscriptions.onContext((s) => used.push(s.used));
  for (let i = 0; i < n; i += 1) fanout.feedStdout(`{"type":"e${i}"}\n`);

  return used;
}

test("a router's bag survives from one event to the next within one child", () => {
  const used = countsAcross(
    createEventFanout({ routeEvent: countingRouter }),
    3,
  );

  assert.deepEqual(
    used,
    [1, 2, 3],
    "the bag was re-created per event, so nothing an earlier event wrote can be read later",
  );
});

/**
 * 🛑 THE DISCRIMINATOR. A module-level bag would pass the test above and fail
 * this one, and its failure in production is one agent's gauge reading another
 * agent's model.
 */
test("two children never share a bag", () => {
  const first = createEventFanout({ routeEvent: countingRouter });
  const second = createEventFanout({ routeEvent: countingRouter });

  countsAcross(first, 2);

  assert.deepEqual(
    countsAcross(second, 1),
    [1],
    "the second child inherited the first child's count, so the bag is shared",
  );
});
