import { test } from "node:test";
import assert from "node:assert/strict";
import { createEventFanout } from "../../src/supervise/drivers/fanout.js";
import { routeCursorEvent } from "../../src/supervise/drivers/cursor.js";
import type { UnnamedToolCall } from "../../src/supervise/child.js";

/**
 * 🔴 THE RELAY HAD NO TEST, AND THE WHOLE #417 FIX ROUTES THROUGH IT.
 *
 * `fanout.ts` forwards `(name, why)` to every subscriber. Dropping the `why`
 * there makes every unnamed call read as `unknown-shape` downstream, which is
 * the one cause that may NOT soften the silent-reply warning — so the fix is
 * deletable at the relay. claude1 killed that argument and the FULL 2690-test
 * suite stayed green.
 *
 * ⚠️ THE WIRING TESTS CANNOT REACH IT. Their harness stubs `spawnChild` and
 * registers the callback directly, so no test crossed this layer.
 */

/** One captured `toolCall` call, both arguments. */
function captureThroughFanout(
  raw: Record<string, unknown>,
): { name: string | null; why?: UnnamedToolCall }[] {
  const seen: { name: string | null; why?: UnnamedToolCall }[] = [];
  const fanout = createEventFanout({ routeEvent: routeCursorEvent });

  fanout.subscriptions.onToolCall((name, why) => {
    seen.push({ name, why });
  });
  fanout.feedStdout(`${JSON.stringify(raw)}\n`);

  return seen;
}

test("🔴 the fanout relay preserves the REASON a tool call was unnameable", () => {
  const seen = captureThroughFanout({
    type: "tool_call",
    tool_call: { mcpToolCall: {} },
  });

  assert.equal(seen.length, 1, "the relay dropped the call entirely");
  assert.equal(seen[0].name, null);
  assert.equal(
    seen[0].why,
    "unnamed-mcp",
    "the reason was lost crossing the fanout, so the downgrade cannot fire",
  );
});

/**
 * 🛑 THE DISCRIMINATOR. A relay that hardcoded `unnamed-mcp` would pass the
 * test above, and it would soften a genuine silent reply. This is the cause
 * that must survive the crossing UNCHANGED.
 */
test("🔴 an unknown SHAPE keeps its own reason across the relay", () => {
  const seen = captureThroughFanout({
    type: "tool_call",
    tool_call: { somethingElse: {} },
  });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].name, null);
  assert.equal(seen[0].why, "unknown-shape");
});

/** A call the driver CAN name carries no reason at all. */
test("a named tool call crosses the relay with no reason", () => {
  const seen = captureThroughFanout({
    type: "tool_call",
    tool_call: { mcpToolCall: { toolName: "mcp__chat__send" } },
  });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].name, "mcp__chat__send");
  assert.equal(seen[0].why, undefined);
});
