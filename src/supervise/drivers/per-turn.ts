import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { AgentChild } from "../child.js";
import type { VendorSpawn } from "../vendor.js";
import { attachStreams, createEventFanout } from "./fanout.js";

/**
 * Spawn one process to carry ONE turn.
 *
 * `resumeSessionId` is the id the previous turn reported, or absent on the
 * first turn. A spawner that drops it gives the agent no memory between turns.
 */
export type TurnSpawner = (o: {
  resumeSessionId?: string;
}) => ChildProcessWithoutNullStreams;

/** One process, and whether its turn finished before it exited. */
interface Turn {
  readonly proc: ChildProcessWithoutNullStreams;
  sawTurnEnd: boolean;
}

/**
 * Turn a CLI that EXITS AFTER EVERY TURN into an `AgentChild`.
 *
 * 🛑 `wireAgentChild`'s `send` CANNOT WORK FOR THESE. It writes a line to a
 * long-lived stdin. `cursor-agent -p` reads its stdin to EOF, treats the whole
 * of it as ONE prompt, and exits — measured on #317. So turn two would write
 * to a closed pipe and the agent would never answer again.
 *
 * 🛑 AN EXIT IS NOT A DEATH HERE, AND THAT IS THE WHOLE DIFFICULTY.
 * `AgentChild.onExit` means the agent is GONE: the supervisor's own `onExit`
 * handler drains the queue, nulls the handle's bus pid and closes the socket. A
 * per-turn child that forwarded every process exit would take itself offline
 * after turn one while still working perfectly.
 *
 * So one fact decides it, and it is the turn-end signal the vendor's own
 * router produced:
 *
 * ```
 * turn ended, then exit 0          a clean turn. NO onExit. The agent lives.
 * turn ended, then exit non-zero   still a clean turn, but the code is SAID.
 * exited with NO turn end          a death. onExit, carrying the code.
 * ```
 *
 * ⚠️ ROW 3 IS THE LOAD-BEARING ONE. `cursor-agent` without `--trust` exits 1
 * having emitted zero events. Routing that to `onTurnEnd` leaves the queue
 * waiting on a process that will never speak; routing it to `onExit` makes
 * the supervisor log every unsent prompt by id. **A dropped prompt that names
 * itself beats a silent hang.** claude1 reviewing this plan.
 */
export function wirePerTurnChild(
  spawnTurn: TurnSpawner,
  // The same PROJECTION `wireAgentChild` takes, so a test fake owes four
  // fields rather than a whole vendor.
  vendor: Pick<
    VendorSpawn,
    "routeEvent" | "encodeInput" | "reportsUsage" | "reportsContext"
  >,
): AgentChild {
  // ONE fan-out across every turn. The supervisor subscribes once, at wiring
  // time, and must keep receiving events from process number four.
  const fanout = createEventFanout(vendor);

  let turn: Turn | null = null;
  let killed = false;

  // 🛑 SUBSCRIBED BEFORE THE CALLER, AND THE ORDER IS LOAD-BEARING. The
  // supervisor's own `onTurnEnd` runs the queue, which calls `send` again and
  // replaces `turn` — so a subscriber registered after it would mark the NEW
  // turn as already finished. Registering here, during construction, puts this
  // first in the array.
  fanout.subscriptions.onTurnEnd(() => {
    if (turn) turn.sawTurnEnd = true;
  });

  /**
   * Put one line in front of the operator through the sink that already
   * reaches the log.
   *
   * ⚠️ FLUSHES FIRST. A partial real stderr line sits in the fan-out's buffer,
   * and appending to it would splice this text onto the child's own words.
   */
  const sayToOperator = (line: string): void => {
    fanout.flushStderr();
    fanout.feedStderr(`${line}\n`);
  };

  const beginTurn = (text: string): void => {
    const proc = spawnTurn({
      // The id from the LAST result, read now rather than captured at wiring
      // time, because on turn one there is no id to capture.
      resumeSessionId: fanout.lastSessionId() ?? undefined,
    });

    const started: Turn = { proc, sawTurnEnd: false };
    turn = started;

    attachStreams(proc, fanout);

    proc.on("exit", (code, signal) => {
      // ⚠️ `turn` MAY ALREADY BE THE NEXT ONE. The turn-end event arrives on
      // stdout BEFORE the process exits, so the queue can have spawned turn
      // N+1 by the time turn N's exit lands. Compare identity, never assume
      // this handler owns the current turn.
      if (turn === started) turn = null;

      if (killed || !started.sawTurnEnd) {
        fanout.emitExit(code, signal);
        return;
      }

      // The answer was delivered, so the agent is not gone — but a CLI that
      // fails on the way out will keep doing it every turn, and a queue
      // reporting success each time is how that stays invisible.
      if (code !== 0) {
        sayToOperator(
          `turn finished, then the CLI exited code=${code} signal=${signal}. ` +
            `The turn's answer was delivered; this is the process failing after it.`,
        );
      }
    });

    // 🛑 STDIN IS THE PROMPT, AND THE EOF IS WHAT STARTS THE TURN. Without
    // the `end()` the CLI waits for more input forever and no event ever
    // arrives. Measured on #317: stdin is read to EOF, not treated as a
    // channel.
    proc.stdin.write(vendor.encodeInput(text));
    proc.stdin.end();
  };

  return {
    reportsUsage: vendor.reportsUsage,
    reportsContext: vendor.reportsContext,

    send(text: string): void {
      // 🛑 AFTER A KILL, SPAWNING IS THE BUG. `kill()` has already told the
      // supervisor the agent is gone, and a process started now would answer
      // onto a bus row that reads offline.
      if (killed) return;

      beginTurn(text);
    },

    ...fanout.subscriptions,

    kill(): void {
      killed = true;

      // The in-flight process's own exit handler reports it, with the real
      // code and signal.
      if (turn) {
        turn.proc.kill();
        return;
      }

      // 🛑 SYNTHESISED, BECAUSE NO PROCESS IS RUNNING BETWEEN TURNS AND THE
      // AGENT IS STILL GONE. `onExit` is the only thing that takes the handle
      // offline and closes the socket, so a kill while idle that emitted
      // nothing would leave a dead agent reading as online.
      fanout.emitExit(null, "SIGTERM");
    },

    // 🛑 NO `awaitTeardown`, DELIBERATELY. Between turns there is nothing to
    // wait for, and a hook that resolves instantly would claim it confirmed a
    // teardown it never saw — `child.ts` names that exact failure. The host
    // wiring omits it for the same reason.
  };
}
