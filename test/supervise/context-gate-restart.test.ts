import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 🛑 BEFORE any import that resolves a state path. See replace-child.test.ts.
process.env.CHAT_MCP_HOME = mkdtempSync(
  join(tmpdir(), "chat-mcp-gaterestart-"),
);

const { migrate } = await import("../../src/storage/db.js");
const dao = await import("../../src/storage/dao.js");
const { startSupervisor } = await import("../../src/supervise/index.js");
const { childHandleFor } = await import("../../src/supervise/grant.js");
const { setHandleContextGate } =
  await import("../../src/storage/context-gate.js");
const { deadPid } = await import("../support/dead-pid.js");
const { deliverToSupervisor } = await import("../../src/supervise/socket.js");
import type { ContextSnapshot } from "../../src/supervise/context-gauge.js";
import { supervisorOptions } from "../support/supervisor-options.js";
import { releasePointerTurn } from "../support/handoff-pointer.js";

/**
 * #135 unit 3a — the automatic trigger on the restart gate.
 *
 * Units 1 and 2 shipped the gate's config and the quiet ramp below it and left
 * both inert. This is the first piece that acts: a reading at or above the
 * handle's own gate runs the graceful restart that `agents restart` already
 * performs by hand.
 *
 * 🛑 WHAT MAKES THESE ABLE TO FAIL IS THE PAIRED READING BELOW THE GATE. A
 * trigger wired to every reading passes any test that only ever reports a full
 * window, so each positive here has a negative beside it.
 */

interface FakeChild {
  sent: string[];
  killed: boolean;
  finishTurn: () => void;
  report: (snapshot: ContextSnapshot) => void;
}

/** A child that records what it was sent and lets a test drive its callbacks. */
function recordingChildren(children: FakeChild[], sendThrows = false) {
  return () => {
    let endTurn: (() => void) | undefined;
    let context: ((snapshot: ContextSnapshot) => void) | undefined;
    const rec: FakeChild = {
      sent: [],
      killed: false,
      finishTurn: () => endTurn?.(),
      report: (snapshot) => context?.(snapshot),
    };
    children.push(rec);

    return {
      reportsUsage: false,
      reportsContext: true,
      send: (t: string) => {
        rec.sent.push(t);

        // The one reachable way to make `checkContextGate` throw: the gate
        // dispatches the notice through the queue, which calls this.
        if (sendThrows) throw new Error("child stdin is gone");
      },
      onTurnEnd: (cb: () => void) => {
        endTurn = cb;
      },
      onContext: (cb: (snapshot: ContextSnapshot) => void) => {
        context = cb;
      },
      onUsage: () => undefined,
      onDenial: () => undefined,
      onToolCall: () => undefined,
      onSession: (cb: (id: string) => void) => cb("sess-1"),
      onEvent: () => undefined,
      onStderr: () => undefined,
      onExit: () => undefined,
      kill: () => {
        rec.killed = true;
      },
    };
  };
}

/** A reading of `percent` against a round million-token window. */
const at = (percent: number): ContextSnapshot => ({
  used: Math.round(percent * 10_000),
  total: 1_000_000,
  model: "claude-opus-5",
  totalIsFallback: false,
});

async function harness(
  suffix: string,
  gate?: number,
  register: boolean = true,
  sendThrows: boolean = false,
) {
  const db = new DatabaseSync(":memory:");
  migrate(db);

  const handle = `ctxgate-${process.pid}-${suffix}`;
  const childHandle = childHandleFor(handle);

  // 🛑 A LONG SUFFIX FAILS AS `listen EINVAL`, WHICH READS LIKE A BROKEN
  // SUPERVISOR. A unix socket path caps at ~104 bytes on macOS and the state
  // dir eats ~82 of them, so `floor-regen` put this over and the test failed
  // IDENTICALLY to its own mutant — proving nothing either way. Fail here, on
  // the cause, instead.
  assert.ok(
    handle.length <= 22,
    `handle "${handle}" is too long for a unix socket path; shorten the suffix`,
  );

  // The SHIM writes this row when the child registers on the bus.
  if (register)
    dao.upsertAgent(db, {
      handle: childHandle,
      pid: deadPid(),
      session_id: "child",
    });

  if (gate !== undefined) setHandleContextGate(db, childHandle, gate);

  const children: FakeChild[] = [];
  const lines: string[] = [];

  const sup = await startSupervisor(
    supervisorOptions({
      handle,
      db,
      extraDirs: [process.cwd()],
      spawnChild: recordingChildren(children, sendThrows),
      log: (line: string) => lines.push(line),
    }),
  );

  // 🛑 THE HANDOFF POINTER IS DISPATCHED AT SPAWN AS ITS OWN TURN, so the
  // child's first `finishTurn` would release the POINTER rather than the turn
  // a test means to end. Released here so every count in this file counts the
  // child's WORK turns.
  releasePointerTurn(children[0]!.sent, children[0]);

  return { db, handle, childHandle, children, lines, sup };
}

const notices = (child: FakeChild | undefined): string[] =>
  (child?.sent ?? []).filter((t) => /restarting/i.test(t));

/**
 * The reading a fresh child opens with: its system prompt plus its tool
 * definitions, before any work.
 *
 * 🛑 EVERY SEQUENCE STARTS HERE BECAUSE A REAL ONE DOES. A test whose FIRST
 * reading is already at the gate is asserting against a child that spawned
 * full, which no child does — and the loop guard correctly refuses to restart
 * one, because a restart cannot reclaim a spawn fill.
 */
const SPAWN_FILL = 14.4;

const spawned = (child: FakeChild | undefined): FakeChild | undefined => {
  child?.report(at(SPAWN_FILL));

  return child;
};

test("a reading below the gate restarts nothing", async () => {
  const h = await harness("under");

  try {
    spawned(h.children[0]);

    // 49.9 against the default gate of 50 — the closest reading that must not
    // act. An `>` / `>=` slip is invisible one whole band away.
    h.children[0]?.report(at(49.9));

    assert.deepEqual(notices(h.children[0]), []);
    assert.equal(h.children[0]?.killed, false);
    assert.equal(h.children.length, 1, "a child was replaced below the gate");
  } finally {
    await h.sup.stop();
  }
});

test("a reading at the gate sends the externalize notice, then restarts on the turn end", async () => {
  const h = await harness("at");

  try {
    spawned(h.children[0])?.report(at(50));

    assert.equal(
      notices(h.children[0]).length,
      1,
      `the notice was never sent; got ${JSON.stringify(h.children[0]?.sent)}`,
    );
    assert.equal(
      h.children[0]?.killed,
      false,
      "killed before the notice turn ended — the child never got to externalize",
    );

    // 🛑 THE COUNTDOWN IS THE CHILD'S OWN TURN ENDING, not a timer the test
    // fakes. `sendNoticeThenFinish` waits for the turn AFTER the one that
    // dispatched the notice.
    h.children[0]?.finishTurn();
    h.children[0]?.finishTurn();

    assert.equal(h.children[0]?.killed, true, "the child was never killed");
    assert.equal(h.children.length, 2, "no replacement child was spawned");
  } finally {
    await h.sup.stop();
  }
});

test("the gate fires once per child, not on every reading above it", async () => {
  const h = await harness("latch");

  try {
    spawned(h.children[0])?.report(at(50));
    h.children[0]?.report(at(61));
    h.children[0]?.report(at(99.9));

    // 🛑 THE DAMAGE IS A SECOND RESTART, NOT A SECOND NOTICE, AND COUNTING
    // NOTICES COULD NOT SEE IT. Each reading arrives mid-turn, so notices two
    // and three sit in the queue undispatched and `sent` holds one either way
    // — a mutant with the latch deleted passed 7 of 7 on that assertion.
    // Every call arms its own wait, and they all fire on the same turn end, so
    // `doRestart` runs once per reading and the later ones kill a REPLACEMENT
    // child that has done no work.
    h.children[0]?.finishTurn();
    h.children[0]?.finishTurn();

    assert.equal(
      h.children.length,
      2,
      "three readings above the gate restarted the child more than once",
    );
    assert.equal(
      notices(h.children[0]).length,
      1,
      "a second reading above the gate dispatched a second notice",
    );
  } finally {
    await h.sup.stop();
  }
});

test("a per-handle gate moves the trigger with it", async () => {
  const h = await harness("override", 80);

  try {
    spawned(h.children[0]);

    // Past the DEFAULT gate of 50 and below this handle's own 80. A trigger
    // reading the default instead of the override fires here.
    h.children[0]?.report(at(60));

    assert.deepEqual(
      notices(h.children[0]),
      [],
      "60% restarted a handle gated at 80",
    );

    h.children[0]?.report(at(80));

    assert.equal(
      notices(h.children[0]).length,
      1,
      "80% did not restart a handle gated at 80",
    );
  } finally {
    await h.sup.stop();
  }
});

test("a gate under the child's spawn fill does NOT restart it, and says why", async () => {
  // 🛑 THIS IS AN INFINITE RESTART LOOP WITHOUT THE GUARD, AND EVERY GATE
  // FROM 1 TO 100 IS LEGAL CONFIG. A fresh container child sat at 14.4% of its
  // window before doing any work, so a gate of 10 is reached by its FIRST
  // reading — and the replacement's first reading is the same number. Found by
  // claude2 reviewing this PR before it was pushed.
  const h = await harness("floor", 10);

  try {
    h.children[0]?.report(at(14.4));
    h.children[0]?.finishTurn();
    h.children[0]?.finishTurn();

    assert.equal(
      h.children.length,
      1,
      "the child was restarted into a window that is still over its gate",
    );
    assert.deepEqual(notices(h.children[0]), []);

    const line = h.lines.find((l) => /spawn|unreachable|cannot/i.test(l));
    assert.ok(
      line,
      `the operator was not told the gate is unreachable; got ${JSON.stringify(h.lines)}`,
    );
    // Both numbers, so the operator knows which one to change.
    assert.match(line, /10/);
    assert.match(line, /14\.4/);
  } finally {
    await h.sup.stop();
  }
});

test("a gate above the spawn fill still fires on a later reading", async () => {
  // The paired control for the guard above. Refusing on a low gate rather than
  // on the FIRST READING would make the whole trigger dead below 15%.
  const h = await harness("floor-ok", 10);

  try {
    h.children[0]?.report(at(5));
    h.children[0]?.report(at(14.4));

    assert.equal(
      notices(h.children[0]).length,
      1,
      "a gate of 10 never fired for a child that spawned at 5%",
    );
  } finally {
    await h.sup.stop();
  }
});

test("a gate changed mid-run is honoured by the NEXT reading", async () => {
  // 🛑 THE DOCBLOCK CLAIMS THIS AND NOTHING PROVED IT. M4 only shows the
  // resolver is consulted at all, not that it is consulted AGAIN. An operator
  // raising a gate to stop a restart is the case that needs it. Asked by
  // claude2, who also asked for the recorded-reading control below.
  const h = await harness("regate");

  try {
    spawned(h.children[0]);

    setHandleContextGate(h.db, h.childHandle, 60);
    h.children[0]?.report(at(55));

    assert.deepEqual(
      notices(h.children[0]),
      [],
      "55% restarted a handle whose gate was just raised to 60",
    );

    // 🛑 THE CONTROL FOR THE ASSERTION ABOVE, because "nothing fired" is also
    // what a reading that never arrived looks like. The gauge records every
    // reading it is given, so this proves the 55 reached the handler at all.
    assert.equal(
      dao.getAgent(h.db, h.childHandle)?.context_used,
      550_000,
      "the 55% reading never reached the gauge, so nothing above was tested",
    );

    setHandleContextGate(h.db, h.childHandle, 50);
    h.children[0]?.report(at(55));

    assert.equal(
      notices(h.children[0]).length,
      1,
      "the gate was lowered to 50 and a 55% reading still did not fire",
    );
  } finally {
    await h.sup.stop();
  }
});

test("the replacement child's spawn fill is measured again, not inherited", async () => {
  // 🛑 WITHOUT THE PER-CHILD RESET THE LOOP COMES BACK, AND THE REGEN TEST
  // BELOW CANNOT SEE IT — both children there spawn at the same fill, so a
  // stale floor is the right number by accident. A mutant deleting the reset
  // passed 9 of 9. This sequence makes the two floors DIFFER.
  const h = await harness("fregen", 10);

  try {
    // Child one spawns under its gate, so the guard correctly stays out of the
    // way, and the gate fires.
    h.children[0]?.report(at(5));
    h.children[0]?.report(at(10));
    h.children[0]?.finishTurn();
    h.children[0]?.finishTurn();

    assert.equal(h.children.length, 2, "the first child was never restarted");

    // 🛑 RELEASED, OR THE TWO ABSENCES BELOW ARE FREE. The replacement is
    // handed its own pointer, and a notice queued behind that open turn never
    // reaches `sent` — so a deleted floor reset would pass on an empty array
    // it never earned. That is the mutant this test's own header names.
    releasePointerTurn(h.children[1]!.sent, h.children[1]);

    // Child two spawns ABOVE the same gate — a different model or tool set
    // moves the floor. Inheriting 5% here restarts it, and its replacement,
    // forever.
    h.children[1]?.report(at(14.4));

    assert.equal(
      h.children.length,
      2,
      "the replacement inherited the first child's floor and restarted on spawn",
    );
    assert.deepEqual(notices(h.children[1]), []);
  } finally {
    await h.sup.stop();
  }
});

test("the replacement child gets its own gate, because the window started over", async () => {
  const h = await harness("regen");

  try {
    spawned(h.children[0])?.report(at(50));
    h.children[0]?.finishTurn();
    h.children[0]?.finishTurn();

    assert.equal(h.children.length, 2, "no replacement child was spawned");

    // The replacement is handed its own pointer; see `releasePointerTurn`.
    releasePointerTurn(h.children[1]!.sent, h.children[1]);

    // 🛑 THE LATCH IS PER CHILD, NOT PER PROCESS. A process-lifetime latch
    // restarts the first child and then lets every one after it fill to 100%
    // unattended, which is the bug this ticket exists to fix.
    spawned(h.children[1])?.report(at(50));

    assert.equal(
      notices(h.children[1]).length,
      1,
      "the replacement child was never restarted at its own gate",
    );
  } finally {
    await h.sup.stop();
  }
});

test("a child that never registered on the bus is still restarted at its gate", async () => {
  const h = await harness("unreg", undefined, false);

  try {
    assert.equal(
      dao.getAgent(h.db, h.childHandle),
      null,
      "the harness registered the row this test needs absent",
    );

    // 🛑 THE GAUGE GIVES UP ON AN UNREGISTERED CHILD AND THE GATE MUST NOT.
    // A row UPDATE against a missing row is a silent no-op, which is why the
    // gauge returns early; a restart writes no row. A child filling its
    // window without ever reaching the bus is the case most in need of one.
    spawned(h.children[0])?.report(at(50));

    assert.equal(
      notices(h.children[0]).length,
      1,
      "an unregistered child was left to fill its window",
    );

    // The paired control, so this cannot pass by restarting unconditionally.
    const under = await harness("unreg2", undefined, false);
    try {
      spawned(under.children[0])?.report(at(49.9));
      assert.deepEqual(notices(under.children[0]), []);
    } finally {
      await under.sup.stop();
    }
  } finally {
    await h.sup.stop();
  }
});

test("a throw inside the gate check does not cost the gauge its reading", async () => {
  // 🛑 THE GATE CHECK RUNS BEFORE THE GAUGE WRITE, SO ONE SHARED CATCH MEANT
  // A THROW HERE SILENTLY LOST BOTH — and logged it as "FAILED to record the
  // context gauge", naming the half that still worked. Nothing before this
  // change could throw ahead of the write. Raised by claude2.
  const h = await harness("throws", undefined, true, true);

  try {
    spawned(h.children[0])?.report(at(50));

    // The reading still landed, which is the whole point of the inner catch.
    assert.equal(
      dao.getAgent(h.db, h.childHandle)?.context_used,
      500_000,
      "a throw in the gate check cost the gauge its reading",
    );

    const line = h.lines.find(
      (l) => /restart gate/i.test(l) && /FAILED/.test(l),
    );

    assert.ok(
      line,
      `the failure was not reported against the gate; got ${JSON.stringify(h.lines)}`,
    );
    assert.match(line, /child stdin is gone/);
  } finally {
    await h.sup.stop();
  }
});

test("a notice that cannot be delivered still restarts the child on the timeout", async () => {
  // 🛑 THE TURN-END PATH IS DEAD WHEN `send` THROWS, and that is not obvious:
  // the `TurnQueue` `send` callback in `startSupervisor` calls `child.send`
  // BEFORE it walks `sendListeners`, so the throw means `onSend` never runs,
  // `noticeDispatchedAtCount` stays null, and `onAnyTurnEnd` returns early
  // forever. Only the 30s timer is left. claude2 asked whether the restart
  // still happens at all — it does, late, and the notice is best-effort.
  const h = await harness("timeout", undefined, true, true);

  mock.timers.enable({ apis: ["setTimeout"] });

  try {
    spawned(h.children[0])?.report(at(50));

    assert.equal(
      h.children.length,
      1,
      "the child was replaced before its grace period elapsed",
    );

    // The turn end cannot carry it, which is the point of this test.
    h.children[0]?.finishTurn();
    h.children[0]?.finishTurn();

    assert.equal(
      h.children.length,
      1,
      "a turn end restarted a child whose notice was never dispatched",
    );

    mock.timers.tick(30_000);

    assert.equal(
      h.children.length,
      2,
      "the 30s graceful-restart timeout never fired, so NOTHING restarts a child with a broken stdin",
    );
  } finally {
    mock.timers.reset();
    await h.sup.stop();
  }
});

/** A driver that reports a reading with no window size at all. */
const NO_WINDOW: ContextSnapshot = {
  used: 0,
  total: 0,
  model: null,
  totalIsFallback: true,
};

test("a reading with no window cannot set the floor", async () => {
  // 🛑 A FLOOR OF 0 DISABLES THE LOOP GUARD FOR THE CHILD'S WHOLE LIFE.
  // `contextPercent` answers 0 for a total of 0, so latching that makes every
  // later reading look like a legitimate climb from empty — and a gate under
  // the real spawn fill loops again. Unreachable on the claude driver, whose
  // fallback window is 200000, but `ContextSnapshot` is the vendor seam and the
  // next driver is not bound by it. Found by claude2 on PR 311.
  const h = await harness("nowin", 10);

  try {
    h.children[0]?.report(NO_WINDOW);
    h.children[0]?.report(at(14.4));

    assert.deepEqual(
      notices(h.children[0]),
      [],
      "a windowless reading set the floor to 0 and the loop guard went off",
    );
    assert.equal(h.children.length, 1);
    assert.ok(
      h.lines.find((l) => /lowest reading/i.test(l)),
      `the gate was not reported as unreachable; got ${JSON.stringify(h.lines)}`,
    );
  } finally {
    await h.sup.stop();
  }
});

test("a windowless reading is SKIPPED, not fatal to the child's gate", async () => {
  // The paired control. Treating a windowless reading as "this child is done"
  // would disable the restart for every child behind a driver that emits one.
  const h = await harness("nowin2", 10);

  try {
    h.children[0]?.report(NO_WINDOW);
    h.children[0]?.report(at(5));
    h.children[0]?.report(at(14.4));

    assert.equal(
      notices(h.children[0]).length,
      1,
      "the gate never fired for a child that really did spawn under it",
    );
  } finally {
    await h.sup.stop();
  }
});

test("the gate restart is logged, naming the reading and the gate it crossed", async () => {
  const h = await harness("log");

  try {
    h.children[0]?.report(at(50));

    const line = h.lines.find((l) => /restart gate/i.test(l));

    assert.ok(line, `no gate line was logged; got ${JSON.stringify(h.lines)}`);
    // Both numbers, because one of them alone cannot tell an operator whether
    // the gate or the reading is the thing they want to change.
    assert.match(line, /50/);
    assert.match(line, new RegExp(h.childHandle));
  } finally {
    await h.sup.stop();
  }
});

/**
 * #477 — the spawn floor latched the FIRST reading, and that reading can be
 * wrong.
 *
 * 🛑 THE NUMBERS BELOW ARE THE MEASURED ONES, NOT CHOSEN ONES. `cursor1-agent`
 * reported 57.4% while its real fill was 23.9%, against a gate of 40. The
 * first reading disabled the gate for the child's whole life, so nothing
 * restarted it and it ran until it stopped answering.
 *
 * 🛑 WHAT MAKES THESE ABLE TO FAIL IS THE PAIRED SEQUENCE THAT NEVER DROPS.
 * A floor that simply stopped disabling the gate would pass the first test and
 * reintroduce the restart loop the guard exists to prevent — which is the arm
 * lee rejected by name on the ticket.
 */

/** The reading `cursor1-agent` gave, which was wrong. */
const WRONG_FILL = 57.4;

/** What its window actually held at the same moment. */
const REAL_FILL = 23.9;

test("a LOWER later reading pulls the floor down, and the gate works again", async () => {
  const h = await harness("fmin", 40);

  try {
    // The wrong reading first, exactly as it arrived. Today this latches as
    // the floor and the gate is dead from here on.
    h.children[0]?.report(at(WRONG_FILL));

    // The real fill, which is well under the gate.
    h.children[0]?.report(at(REAL_FILL));

    // A reading that has genuinely reached the operator's gate.
    h.children[0]?.report(at(40));

    assert.equal(
      notices(h.children[0]).length,
      1,
      `the gate stayed disabled by a wrong first reading; sent ${JSON.stringify(h.children[0]?.sent)}`,
    );
  } finally {
    await h.sup.stop();
  }
});

test("a floor that never drops keeps the gate off, so nothing restart-loops", async () => {
  // 🛑 THE PAIRED CONTROL. lee rejected clamping on #477 because a replacement
  // child boots straight back above the gate and restarts again, burning
  // billed turns without finishing one. A floor that only ever falls cannot do
  // that; one that is reset or ignored can.
  const h = await harness("fhigh", 40);

  try {
    h.children[0]?.report(at(WRONG_FILL));
    h.children[0]?.report(at(60));
    h.children[0]?.report(at(58));

    assert.deepEqual(
      notices(h.children[0]),
      [],
      "a child whose fill never fell below its gate was restarted anyway",
    );
    assert.equal(h.children.length, 1, "the child was replaced");
  } finally {
    await h.sup.stop();
  }
});

test("the unreachable-gate warning is RETRACTED once a lower floor revives it", async () => {
  // 🛑 WITHOUT THIS THE OPERATOR IS LEFT WITH A FALSE SENTENCE. The first
  // warning says "NOTHING will restart this child", and the moment a lower
  // reading pulls the floor under the gate that is no longer true. A warning
  // that cannot be withdrawn is worse than none, because it is acted on.
  const h = await harness("fundo", 40);

  try {
    h.children[0]?.report(at(WRONG_FILL));

    assert.ok(
      h.lines.find((l) => /NOTHING will restart/i.test(l)),
      `the gate was never reported unreachable; got ${JSON.stringify(h.lines)}`,
    );

    h.children[0]?.report(at(REAL_FILL));

    const undo = h.lines.find((l) => /can restart|is reachable again/i.test(l));

    assert.ok(
      undo,
      `the unreachable warning was never withdrawn; got ${JSON.stringify(h.lines)}`,
    );
    // Both numbers, so the operator can see WHICH reading revived it.
    assert.match(undo, /40/);
    assert.match(undo, /23\.9/);
  } finally {
    await h.sup.stop();
  }
});

test("the retraction is logged ONCE, not on every reading under the gate", async () => {
  // The warning's own `warnedGateUnderFloor` latch exists because a line per
  // reading is a line an operator stops reading. Its withdrawal needs the
  // same property, and a fresh flag is the thing most likely to be forgotten.
  const h = await harness("fonce", 40);

  try {
    h.children[0]?.report(at(WRONG_FILL));
    h.children[0]?.report(at(REAL_FILL));
    h.children[0]?.report(at(20));
    h.children[0]?.report(at(21));

    const undos = h.lines.filter((l) =>
      /can restart|is reachable again/i.test(l),
    );

    assert.equal(
      undos.length,
      1,
      `the retraction repeated; got ${JSON.stringify(undos)}`,
    );
  } finally {
    await h.sup.stop();
  }
});

test("a replacement child can be warned and retracted on its own account", async () => {
  // 🛑 THE RETRACTION FLAG NEEDS THE SAME RESET THE WARNING FLAG HAS. Without
  // it the first child spends the retraction for every child after it, and a
  // replacement that recovers is never reported as recovered. This is the
  // clause most likely to be left out, because nothing else in the file reads
  // it. `feedback_pin_every_clause_of_a_compound_guard`.
  const h = await harness("frepl", 40);

  try {
    // Child one: warned, then withdrawn, then restarted at its gate.
    h.children[0]?.report(at(WRONG_FILL));
    h.children[0]?.report(at(REAL_FILL));
    h.children[0]?.report(at(40));
    h.children[0]?.finishTurn();
    h.children[0]?.finishTurn();

    assert.equal(h.children.length, 2, "the child was never replaced");

    const before = h.lines.filter((l) => /is reachable again/i.test(l)).length;

    // Child two walks the same path, so it is owed its own pair of lines.
    h.children[1]?.report(at(WRONG_FILL));
    h.children[1]?.report(at(REAL_FILL));

    assert.equal(
      h.lines.filter((l) => /is reachable again/i.test(l)).length,
      before + 1,
      "the replacement child was never told its gate came back",
    );
  } finally {
    await h.sup.stop();
  }
});

test("a gate LOWERED after the retraction warns again, so the last line is true", async () => {
  // 🛑 EACH CROSSING LOGS ONCE, NOT EACH STATE ONCE EVER. Both latches are
  // per-child, so without them clearing each other the operator who lowers the
  // gate after a withdrawal is left reading "the gate is reachable again"
  // about a child nothing can restart. The floor only falls, but the GATE
  // moves — `resolveContextGate` is read on every reading, which
  // `a gate changed mid-run is honoured by the NEXT reading` already pins.
  // Raised by claude1 reviewing PR 487.
  const h = await harness("fredo", 40);

  try {
    h.children[0]?.report(at(WRONG_FILL));
    h.children[0]?.report(at(REAL_FILL));

    assert.equal(
      h.lines.filter((l) => /is reachable again/i.test(l)).length,
      1,
      "the withdrawal never happened, so this test proves nothing",
    );

    // The operator lowers the gate under the floor the child now reads.
    setHandleContextGate(h.db, h.childHandle, 20);
    h.children[0]?.report(at(REAL_FILL));

    const warns = h.lines.filter((l) => /NOTHING will restart/i.test(l));

    assert.equal(
      warns.length,
      2,
      `the child became unrestartable in silence; got ${JSON.stringify(h.lines)}`,
    );
    // The SECOND warning carries the new gate, not the old one.
    assert.match(warns[1]!, /20/);
  } finally {
    await h.sup.stop();
  }
});

test("a replacement that is NOT a gate restart still gets its own warning", async () => {
  // 🛑 THE CONTROL FOR THE PER-CHILD RESET, AND MY FIRST ATTEMPT AT IT COULD
  // NOT FAIL. Every other replacement in this file is driven BY the gate, and
  // the gate retracts the warning on its way there — so the flag was already
  // false at replacement and deleting the reset changed nothing. Measured: the
  // reset's mutant passed 21 of 21.
  //
  // 🛑 AN OPERATOR APPROVAL IS THE PATH THAT REACHES IT. It replaces the child
  // for reasons that have nothing to do with the gate, so the warning is still
  // standing when the new child arrives. A child that inherits it is a child
  // whose own unreachable gate is never reported.
  const h = await harness("fappr", 40);

  try {
    h.children[0]?.report(at(WRONG_FILL));

    const warned = h.lines.filter((l) => /NOTHING will restart/i.test(l));

    assert.equal(
      warned.length,
      1,
      `the first child was never warned, so this test proves nothing; got ${JSON.stringify(h.lines)}`,
    );

    await deliverToSupervisor(h.handle, {
      id: 1,
      to: h.handle,
      from: "lee",
      ts: Date.now(),
      approval: {
        approvalId: 1,
        decision: "approve",
        requested: "rm in '/tmp/gate.txt'",
        grant: "Bash(rm -f /tmp/gate.txt)",
        sessionId: "sess-1",
      },
    });

    assert.equal(
      h.children.length,
      2,
      "the approval did not replace the child, so there is no second child to warn",
    );

    h.children[1]?.report(at(WRONG_FILL));

    assert.equal(
      h.lines.filter((l) => /NOTHING will restart/i.test(l)).length,
      2,
      `the replacement inherited the warning and its own dead gate went unreported; got ${JSON.stringify(h.lines)}`,
    );
  } finally {
    await h.sup.stop();
  }
});

test("RAISING the gate withdraws the warning too, and the message blames neither", async () => {
  // 🛑 THE OTHER WAY INTO THE WITHDRAWAL, AND IT HAD NO CONTROL. Every other
  // test reaches that branch by the floor FALLING. `childFloor` is monotonic,
  // so it is reached just as often by the operator RAISING the gate — which is
  // literally what the warning asks them to do. Raised by claude1 on PR 487.
  const h = await harness("frais", 50);

  try {
    h.children[0]?.report(at(WRONG_FILL));

    assert.equal(
      h.lines.filter((l) => /raise the gate/i.test(l)).length,
      1,
      `the child was never warned, so this test proves nothing; got ${JSON.stringify(h.lines)}`,
    );

    // The operator does exactly what the warning asked.
    setHandleContextGate(h.db, h.childHandle, 60);
    h.children[0]?.report(at(WRONG_FILL));

    const undo = h.lines.find((l) => /is withdrawn/i.test(l));

    assert.ok(
      undo,
      `raising the gate left the false warning standing; got ${JSON.stringify(h.lines)}`,
    );
    // Both numbers, so the operator can see the crossing.
    assert.match(undo, /57\.4/);
    assert.match(undo, /60/);

    // 🛑 AND IT MUST NOT CREDIT THE READING. The floor did not move here, the
    // gate did. "now reads" is true and misleading on this path.
    assert.doesNotMatch(
      undo,
      /now reads/i,
      "the message credits the reading for a gate the operator moved",
    );
  } finally {
    await h.sup.stop();
  }
});
