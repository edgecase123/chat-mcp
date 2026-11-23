import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 🛑 BEFORE any import that resolves a state path. See replace-child.test.ts.
process.env.CHAT_MCP_HOME = mkdtempSync(
  join(tmpdir(), "chat-mcp-silentreply-"),
);

const { migrate } = await import("../../src/storage/db.js");
const { startSupervisor } = await import("../../src/supervise/index.js");
const { deliverToSupervisor } = await import("../../src/supervise/socket.js");
import type { AgentChild, SpawnOptions } from "../../src/supervise/child.js";
import { supervisorOptions } from "../support/supervisor-options.js";
import type { UnnamedToolCall } from "../../src/supervise/child.js";

/**
 * 🛑 THE AGENT ANSWERED, AND THE PEER GOT NOTHING.
 *
 * #209 made "the child said nothing" visible. This is the inverse: the child
 * produced prose and never called `send`, so the log read exactly like a
 * delivered reply. `silent-reply.ts` owns the decision; this file owns the
 * wiring, which is where `owed` and the turn-end ORDER can be wrong.
 */

// 🛑 KEEP TEST HANDLES SHORT — UNDER ABOUT TEN CHARACTERS. The supervisor
// binds a unix socket at <tmp>/sock/<handle>-<pid>, and macOS caps that path at
// 104 bytes. "unnamed-mcp-wiring" produced 106 and failed with a bare
// `listen EINVAL`, which names neither the handle nor the limit.
function harness() {
  const lines: string[] = [];
  let emit: ((event: Record<string, unknown>) => void) | undefined;
  let endTurn: (() => void) | undefined;
  let toolCall:
    ((name: string | null, why?: UnnamedToolCall) => void) | undefined;
  const sent: string[] = [];

  const spawnChild = (_opts: SpawnOptions): AgentChild => ({
    reportsUsage: false,
    reportsContext: true,
    send: (text: string) => {
      sent.push(text);
    },
    onTurnEnd: (cb) => {
      endTurn = cb;
    },
    onContext: () => undefined,
    onUsage: () => undefined,
    onDenial: () => undefined,
    onToolCall: (cb) => {
      toolCall = cb;
    },
    onSession: (cb) => cb("sess"),
    onEvent: (cb) => {
      emit = cb;
    },
    onStderr: () => undefined,
    onExit: () => undefined,
    kill: () => undefined,
  });

  return {
    lines,
    sent,
    spawnChild,
    emit: (e: Record<string, unknown>) => emit?.(e),
    // 🛑 THE DRIVER NAMES THE TOOL NOW, so the wiring test must drive the
    // same sink the real routers do. Emitting a `tool_use` BLOCK here would
    // test a path `observe` no longer reads. #392.
    toolCall: (name: string | null, why?: UnnamedToolCall) =>
      toolCall?.(name, why),
    endTurn: () => endTurn?.(),
    warnings: () => lines.filter((l) => /nobody received it/.test(l)),
  };
}

function text(t: string): Record<string, unknown> {
  return {
    type: "assistant",
    message: { content: [{ type: "text", text: t }] },
  };
}

async function supervisor(h: ReturnType<typeof harness>, tag: string) {
  const db = new DatabaseSync(":memory:");
  migrate(db);
  const handle = `${tag}-${process.pid}`;

  const sup = await startSupervisor(
    supervisorOptions({
      handle,
      db,
      extraDirs: [process.cwd()],
      spawnChild: h.spawnChild,
      log: (line: string) => h.lines.push(line),
    }),
  );

  return { sup, handle };
}

function envelope(handle: string, id: number) {
  return {
    id,
    to: handle,
    from: "lee",
    ts: Date.now(),
    kind: "chat" as const,
    body: `question ${id}`,
  };
}

test("a reply owed to a peer, with no send, is reported at turn end", async () => {
  const h = harness();
  const { sup, handle } = await supervisor(h, "owed");

  try {
    await deliverToSupervisor(handle, envelope(handle, 1));

    h.emit(text("Here is the answer."));
    h.endTurn();

    assert.equal(
      h.warnings().length,
      1,
      `no warning was logged; lines were ${JSON.stringify(h.lines)}`,
    );
  } finally {
    await sup.stop();
  }
});

test("a turn that called send is not reported", async () => {
  const h = harness();
  const { sup, handle } = await supervisor(h, "sent");

  try {
    await deliverToSupervisor(handle, envelope(handle, 1));

    h.emit(text("Here is the answer."));
    h.toolCall("mcp__chat__send");
    h.endTurn();

    assert.deepEqual(h.warnings(), []);
  } finally {
    await sup.stop();
  }
});

/**
 * 🛑 THE WIRING OF `owed`, WHICH THE UNIT TEST CANNOT REACH. With no inbound
 * message there is no peer waiting, so prose alone must stay silent — or the
 * supervisor warns on every internal prompt it issues itself.
 */
test("prose with no inbound message at all is not reported", async () => {
  const h = harness();
  const { sup } = await supervisor(h, "unowed");

  try {
    h.emit(text("Thinking out loud, nobody asked."));
    h.endTurn();

    assert.deepEqual(h.warnings(), []);
  } finally {
    await sup.stop();
  }
});

/**
 * 🛑 THE ORDER IS THE BUG THIS TEST EXISTS FOR. `queue.turnEnded()` can
 * dispatch a prompt that was waiting behind the in-flight turn, and that
 * dispatch STARTS A NEW TURN. Reading the verdict after it would read the new
 * turn's empty state and report nothing.
 */
test("a queued second message does not erase the first turn's verdict", async () => {
  const h = harness();
  const { sup, handle } = await supervisor(h, "queued");

  try {
    await deliverToSupervisor(handle, envelope(handle, 1));
    await deliverToSupervisor(handle, envelope(handle, 2));

    h.emit(text("An answer to the first, told to nobody."));
    h.endTurn();

    assert.equal(
      h.warnings().length,
      1,
      `the queued prompt erased the verdict; lines were ${JSON.stringify(h.lines)}`,
    );
    assert.equal(h.sent.length, 2, "the second prompt was never dispatched");
  } finally {
    await sup.stop();
  }
});

/**
 * 🛑 THE UNNAMEABLE CALL, WIRED. Cursor's event shape is read out of its
 * shipped bundle rather than off a captured stream, so a wrong field path is
 * possible — and its failure mode is the silence #392 exists to end. The
 * supervisor logs it, so a wrong guess is something an operator can report.
 */
test("🔴 a tool call the driver could not NAME is logged, and still warns", async () => {
  const h = harness();
  const { sup, handle } = await supervisor(h, "unnamed");

  try {
    await deliverToSupervisor(handle, envelope(handle, 1));

    h.emit(text("Here is the answer."));
    h.toolCall(null);
    h.endTurn();

    assert.ok(
      h.lines.some((l) => /could not read its name/.test(l)),
      "an unreadable tool call was swallowed, which is the bug under a new name",
    );
    assert.equal(h.warnings().length, 1, "a nameless call cleared the warning");
  } finally {
    await sup.stop();
  }
});

/**
 * \u{1F6D1} THE PRODUCTION PATH, WHICH IS THE ONE THE UNIT TEST COULD NOT REACH.
 * `index.ts` used to `return` on a null name BEFORE `observeToolCall`, so the
 * fold never saw it and the unit test for that branch called a function
 * production never called with that argument. This drives the real sink. #417.
 */
test("an unnameable MCP call reaches the fold and withholds the claim", async () => {
  const h = harness();
  const { sup, handle } = await supervisor(h, "mcpnull");

  try {
    await deliverToSupervisor(handle, envelope(handle, 1));

    h.emit(text("Here is the answer."));
    h.toolCall(null, "unnamed-mcp");
    h.endTurn();

    assert.equal(
      h.warnings().length,
      0,
      "the confident line fired on a call that may have BEEN the send",
    );
    assert.ok(
      h.lines.some((l) => /is UNKNOWN/.test(l)),
      "no line reported the delivery as unknown",
    );
  } finally {
    await sup.stop();
  }
});

/**
 * \u{26A0}\u{FE0F} THE SCOPE, AT THE WIRING LEVEL. An unknown SHAPE must still get
 * the confident line, or this fix hides the lost reply it was meant to expose.
 */
test("an unknown tool SHAPE still reaches the confident line", async () => {
  const h = harness();
  const { sup, handle } = await supervisor(h, "shapenull");

  try {
    await deliverToSupervisor(handle, envelope(handle, 1));

    h.emit(text("Here is the answer."));
    h.toolCall(null, "unknown-shape");
    h.endTurn();

    assert.equal(
      h.warnings().length,
      1,
      "an unknown shape softened the warning",
    );
  } finally {
    await sup.stop();
  }
});
