import { test } from "node:test";
import assert from "node:assert/strict";
import { agentRow, stopButtonOrder } from "../../web/assets/logic.js";

/**
 * #415 slice 2 — the operator-facing half of the per-vendor stop default.
 *
 * 🛑 SLICE 1 CHANGED NOTHING AN OPERATOR SEES. The panel always sends an
 * explicit `mode`, so only an API caller that omits one reached the server's
 * resolver. The row still offered `Stop` first for every vendor, which is the
 * button lee's ruling of 2026-11-24 moved away from for a per-turn vendor.
 *
 * 🛑 THE ORDER IS A PURE FUNCTION, NOT A BRANCH IN THE RENDERER. `app.js` maps
 * one `stopButton` call over this list, so the labels are pinned by a unit
 * test rather than by a text scan of the renderer.
 */

/**
 * 🛑 THE DEFAULT GOES FIRST. An operator reaching for the leftmost button is
 * the whole mechanism — lee's ruling only reaches them if the cheaper stop is
 * the one their hand lands on.
 */
test("a per-turn vendor's row offers Stop now FIRST", () => {
  assert.deepEqual(stopButtonOrder("now"), [
    { label: "Stop now", mode: "now" },
    { label: "Stop", mode: "graceful" },
  ]);
});

test("a continuous vendor's row still offers Stop first, unchanged", () => {
  assert.deepEqual(stopButtonOrder("graceful"), [
    { label: "Stop", mode: "graceful" },
    { label: "Stop now", mode: "now" },
  ]);
});

/**
 * ⚠️ THE PAIRED CONTROL FOR THE TWO ABOVE. A function returning only its
 * default button would satisfy either one of them on its own, and the row
 * would silently lose the other stop.
 */
test("both stops are always offered, in both orders", () => {
  for (const mode of ["now", "graceful"]) {
    const labels = stopButtonOrder(mode).map((b) => b.label);

    assert.equal(labels.length, 2, `${mode} offered ${labels.length} buttons`);
    assert.deepEqual([...labels].sort(), ["Stop", "Stop now"]);
  }
});

/**
 * 🛑 AN ABSENT FIELD KEEPS TODAY'S ORDER. A cached page, or a response from a
 * server older than this slice, carries no `defaultStopMode`, and inventing
 * `now` there would make an immediate kill the default for every vendor.
 *
 * ⚠️ THE SAME SMALLER CLAIM `defaultStopModeFor` MAKES FOR AN UNKNOWN VENDOR.
 */
test("an absent or unknown default keeps the shipped order", () => {
  for (const mode of [undefined, null, "", "nonsense"]) {
    assert.deepEqual(
      stopButtonOrder(mode).map((b) => b.mode),
      ["graceful", "now"],
      `${String(mode)} reordered the row`,
    );
  }
});

/**
 * 🛑 THE ROW READS A DECISION, NOT A CAPABILITY. The browser never learns
 * `processPerTurn`, so no vendor map is hand-typed under `web/assets/` and
 * nothing there can drift out of step with the adapters.
 */
test("the row carries the server's resolved defaultStopMode", () => {
  const r = agentRow({
    handle: "smoke-container",
    defaultStopMode: "now",
    child: { handle: "smoke-container-agent" },
  });

  assert.equal(r.defaultStopMode, "now");
});

test("a row with no defaultStopMode falls back to graceful", () => {
  const r = agentRow({ handle: "smoke-container", child: null });

  assert.equal(r.defaultStopMode, "graceful");
});
