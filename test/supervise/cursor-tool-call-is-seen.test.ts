import { test } from "node:test";
import assert from "node:assert/strict";
import { routeCursorEvent } from "../../src/supervise/drivers/cursor.js";
import { routeClaudeEvent } from "../../src/supervise/drivers/claude.js";
import { spawnFor, vendorsWithSpawn } from "../../src/adapters/index.js";

/**
 * #392: every Cursor turn was reported as having answered nobody, including
 * the turns that put a message on the bus.
 *
 * 🛑 CURSOR EMITS A TOP-LEVEL `tool_call` EVENT, NOT A BLOCK INSIDE AN
 * `assistant` MESSAGE. `observe` returned at its first line for anything that
 * was not `type: "assistant"`, so the call was invisible to it by
 * construction — while the TEXT half matched, so every sending turn was
 * reported as silent and a real silent reply became indistinguishable.
 *
 * ⚠️ THE SHAPE IS READ OUT OF THE SHIPPED BUNDLE, version 2026.11.19-f005e9d,
 * not off a captured stream. The emission site is a literal:
 *
 *   type:"tool_call",subtype:"started",call_id:…,tool_call:…,session_id:…
 *
 * 🛑 THE EVENT KEYS ARE HAND-WRITTEN snake_case AND THE NESTED VALUE IS NOT.
 * The writer passes `tool_call: n.message.value.toolCall`, a raw internal
 * object, so the nesting under it is camelCase — `mcpToolCall`, `toolName`.
 * `mcp_tool_call` appears in this bundle twice and both are protobuf schema
 * strings. Measured by claude1, confirmed independently against the same
 * files.
 */

function sink() {
  const names: (string | null)[] = [];

  return {
    names,
    on: {
      turnEnd: () => undefined,
      usage: () => undefined,
      toolCall: (name: string | null) => names.push(name),
    },
  };
}

const started = (toolCall: unknown) => ({
  type: "tool_call",
  subtype: "started",
  call_id: "c1",
  tool_call: toolCall,
  session_id: "s1",
  timestamp_ms: 1,
});

test("🔴 a Cursor MCP tool call is reported, with its BARE tool name", () => {
  const s = sink();

  routeCursorEvent(
    started({
      mcpToolCall: { providerIdentifier: "chat", toolName: "send" },
    }),
    s.on,
  );

  assert.deepEqual(s.names, ["send"]);
});

/**
 * 🛑 THE MOST IMPORTANT TEST IN THIS FILE. The nesting above is read off a
 * bundle rather than a captured event, so it may be wrong — and the failure
 * mode of a wrong path is EXACTLY the silence #392 is about.
 *
 * A `tool_call` event whose name cannot be extracted therefore reports
 * `null`, which the supervisor logs. A wrong guess becomes a SIGNAL instead
 * of more silence.
 */
test("🔴 a tool_call whose name cannot be READ reports null, it is not dropped", () => {
  const s = sink();

  routeCursorEvent(started({ somethingNobodyPredicted: { id: 1 } }), s.on);

  assert.deepEqual(
    s.names,
    [null],
    "an unreadable tool call was swallowed, which is the bug under a new name",
  );
});

test("🛑 the unreadable case fires for a MISSING tool_call member too", () => {
  const s = sink();

  routeCursorEvent({ ...started(undefined), tool_call: undefined }, s.on);

  assert.deepEqual(s.names, [null]);
});

/**
 * ⚠️ BOTH SUBTYPES ARE EMITTED FOR ONE CALL, so counting them would double.
 * `turn.sent` only ever moves to true, so this is not a correctness bug
 * today — it is pinned so a future counter does not inherit the surprise.
 */
test("🛑 started AND completed both report, so a COUNT of them is not a count of calls", () => {
  const s = sink();
  const call = { mcpToolCall: { toolName: "send" } };

  routeCursorEvent(started(call), s.on);
  routeCursorEvent({ ...started(call), subtype: "completed" }, s.on);

  assert.deepEqual(s.names, ["send", "send"]);
});

test("🔴 control — a Cursor event that is NOT a tool call reports nothing", () => {
  const s = sink();

  routeCursorEvent({ type: "assistant", session_id: "s1" }, s.on);
  routeCursorEvent({ type: "result", session_id: "s1" }, s.on);

  assert.deepEqual(s.names, []);
});

/**
 * 🛑 THE CLAUDE HALF MUST KEEP WORKING, and it moved. `observe` used to read
 * `tool_use` blocks itself; that half is gone, so if the Claude router does
 * not report them the detector goes blind for the vendor it already covered.
 */
test("🔴 Claude's tool_use blocks are reported through the SAME sink", () => {
  const s = sink();

  routeClaudeEvent(
    {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "on it" },
          { type: "tool_use", id: "t1", name: "mcp__chat__send", input: {} },
        ],
      },
    },
    s.on,
  );

  assert.deepEqual(s.names, ["mcp__chat__send"]);
});

/**
 * 🛑 THE DENOMINATOR. `toolCall` is OPTIONAL on the router contract, so a
 * vendor that never calls it makes every assertion above vacuous for itself
 * rather than failing. This pins that every vendor with a spawn reports one.
 */
test("🛑 EVERY vendor's router reports a tool call, and there is at least one", () => {
  let checked = 0;

  for (const name of vendorsWithSpawn()) {
    const spawn = spawnFor(name);
    const s = sink();

    checked += 1;

    // Each vendor is handed BOTH shapes; it must recognise exactly its own.
    spawn.routeEvent(
      started({ mcpToolCall: { toolName: "send" } }),
      s.on as never,
      {},
    );
    spawn.routeEvent(
      {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", id: "t", name: "send", input: {} }],
        },
      },
      s.on as never,
      {},
    );

    assert.ok(
      s.names.length > 0,
      `vendor "${name}" reported no tool call for either shape, so the silent-reply ` +
        `detector is blind for it`,
    );
  }

  assert.ok(checked > 0, "no vendor has a spawn, so this test proves nothing");
});

/**
 * 🛑 THE PAIRED CONTROL FOR THE NULL GUARD, AND IT FAILED THE FIRST CUT.
 *
 * A `kind` fallback named this object `"other"`, which is not null — so the
 * guard did not fire, `isOutboundChatTool` said no, and a bus `send` under a
 * wrong field path produced the SAME false warning as #392 with nothing
 * reporting that the driver could not read the call.
 *
 * ⚠️ MY OWN FIXTURE HID IT. `{somethingNobodyPredicted:{…}}` omits `kind`, so
 * it exercised the one shape where the guard still worked. claude1 on PR 393,
 * and the same shape of miss as the leaf-directory fixture on PR 389.
 */
test("🔴 a realish tool_call with a `kind` but NO variant key reports null", () => {
  const s = sink();

  routeCursorEvent(
    started({ toolCallId: "t1", title: "Other", kind: "other", status: "ok" }),
    s.on,
  );

  assert.deepEqual(
    s.names,
    [null],
    "a `kind` was read as the tool's name, which silences the guard",
  );
});

/**
 * 🛑 THE VARIANT KEY IS THE RELIABLE NAME. `tool_call` is a oneof and its
 * variants are each `*_tool_call`; 49 distinct camelCase `*ToolCall` keys
 * appear in the bundle at 2026.11.19-f005e9d. Naming a call from the key needs
 * no knowledge of what is inside it.
 */
test("🔴 a built-in Cursor tool is named by its VARIANT KEY", () => {
  const s = sink();

  routeCursorEvent(started({ shellToolCall: { command: "ls" } }), s.on);

  assert.deepEqual(s.names, ["shellToolCall"]);
});

/**
 * 🛑 AN MCP CALL WE CANNOT NAME IS THE DANGEROUS ONE, so it reports null
 * rather than falling back to its variant key. `mcpToolCall` is the only
 * variant a bus `send` can arrive under — naming it `"mcpToolCall"` would say
 * "a tool ran and it was not a send", which is the claim we cannot make.
 */
test("🔴 an mcpToolCall with no readable toolName reports null, not its key", () => {
  const s = sink();

  routeCursorEvent(
    started({ mcpToolCall: { providerIdentifier: "chat" } }),
    s.on,
  );

  assert.deepEqual(s.names, [null]);
});

test("🛑 TWO variant keys is ambiguous and reports null", () => {
  const s = sink();

  routeCursorEvent(
    started({ shellToolCall: { command: "ls" }, readToolCall: { path: "a" } }),
    s.on,
  );

  assert.deepEqual(s.names, [null]);
});
