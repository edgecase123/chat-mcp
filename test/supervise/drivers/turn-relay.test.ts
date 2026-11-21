import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import {
  frameTurn,
  runTurnRelay,
  unframeTurn,
  UNFRAMED_PROMPT_EXIT,
} from "../../../src/supervise/drivers/turn-relay.js";
import { routeCursorEvent } from "../../../src/supervise/drivers/cursor.js";

/**
 * 🛑 THE CONTAINER-SIDE HALF OF #380, DRIVEN BY A FAKE RATHER THAN BY CURSOR.
 *
 * `cursor-agent` costs money per turn, so the relay takes its turn spawner as
 * a parameter and these tests hand it a controllable stand-in.
 */

interface FakeTurn {
  readonly proc: ChildProcessWithoutNullStreams;
  /** Everything written to this turn's stdin, concatenated. */
  stdin: string;
  stdinEnded: boolean;
  say(line: string): void;
  /** stdout WITHOUT a trailing newline — the shape `say` cannot express. */
  sayPartial(text: string): void;
  /** What node does when a spawn fails: `error`, and no `exit` ever. */
  fail(err: Error): void;
  exit(code: number | null): void;
}

function fakeTurn(): FakeTurn {
  const stdout = new EventEmitter() as EventEmitter & {
    setEncoding: (e: string) => void;
  };
  stdout.setEncoding = () => undefined;

  const stderr = new EventEmitter() as EventEmitter & {
    setEncoding: (e: string) => void;
  };
  stderr.setEncoding = () => undefined;

  const lifecycle = new EventEmitter();

  const turn: FakeTurn = {
    proc: {
      stdout,
      stderr,
      stdin: {
        write: (chunk: string) => {
          turn.stdin += chunk;

          return true;
        },
        end: () => {
          turn.stdinEnded = true;
        },
      },
      on: (event: string, fn: (...a: unknown[]) => void) => {
        lifecycle.on(event, fn);

        return turn.proc;
      },
    } as unknown as ChildProcessWithoutNullStreams,
    stdin: "",
    stdinEnded: false,
    say: (line: string) => stdout.emit("data", `${line}\n`),
    sayPartial: (text: string) => stdout.emit("data", text),
    exit: (code: number | null) => lifecycle.emit("exit", code, null),
    fail: (err: Error) => lifecycle.emit("error", err),
  };

  return turn;
}

interface TurnRequest {
  readonly prompt: string;
  readonly resumeSessionId?: string;
}

interface Harness {
  readonly input: PassThrough;
  readonly written: () => string;
  readonly errors: () => string;
  readonly turns: FakeTurn[];
  readonly prompts: string[];
  readonly requests: TurnRequest[];
  readonly exits: (number | null)[];
  /** Feed one already-framed prompt, as the supervisor would. */
  send(prompt: string): void;
}

function harness(initialSessionId?: string): Harness {
  const input = new PassThrough();
  const output = new PassThrough();
  let seen = "";
  output.on("data", (c: Buffer) => {
    seen += c.toString("utf8");
  });

  const errorOutput = new PassThrough();
  let errors = "";
  errorOutput.on("data", (c: Buffer) => {
    errors += c.toString("utf8");
  });

  const turns: FakeTurn[] = [];
  const prompts: string[] = [];
  const requests: TurnRequest[] = [];
  const exits: (number | null)[] = [];

  runTurnRelay({
    input,
    output,
    errorOutput,
    // 🛑 THE REAL ROUTER, NOT A STAND-IN. The property under test is that the
    // relay and the supervisor cannot disagree about a turn end, and a fake
    // router would be exactly the second opinion this is meant to exclude.
    routeEvent: routeCursorEvent,
    initialSessionId,
    spawnTurn: (request: TurnRequest) => {
      requests.push(request);
      prompts.push(request.prompt);
      const turn = fakeTurn();
      turns.push(turn);

      return turn.proc;
    },
    exit: (code) => exits.push(code),
  });

  return {
    input,
    written: () => seen,
    errors: () => errors,
    turns,
    prompts,
    requests,
    exits,
    send: (prompt: string) => input.write(frameTurn(prompt)),
  };
}

test("one framed line spawns one turn carrying the DECODED prompt", () => {
  const h = harness();

  h.send("summarise the diff");

  assert.equal(h.turns.length, 1);
  assert.deepEqual(h.prompts, ["summarise the diff"]);
});

/**
 * 🛑 THIS IS #380. `wireAgentChild` writes a line to a long-lived stdin and
 * never closes it, so `cursor-agent -p` — which reads stdin to EOF — blocks
 * on an EOF that never comes and emits zero frames.
 */
test("🛑 the turn's stdin is ENDED after the prompt, which is the whole bug", () => {
  const h = harness();

  h.send("go");

  assert.equal(
    h.turns[0].stdinEnded,
    true,
    "stdin was left open, so cursor-agent will block on EOF forever",
  );
});

/**
 * ⚠️ SPLIT FROM THE TEST ABOVE DELIBERATELY. Asserting the content and the
 * close together meant two different mutants — a dropped `write` and a dropped
 * `end` — killed the same one test, so a failure could not name its cause.
 */
test("the prompt itself reaches the turn's stdin", () => {
  const h = harness();

  h.send("go");

  assert.equal(h.turns[0].stdin, "go");
});

/**
 * 🛑 THE REASON FRAMING IS NOT NEWLINE-TERMINATED. `cursorEncodeInput` is the
 * identity function, so a prompt's own newlines are indistinguishable from a
 * prompt boundary. Two turns for one prompt is the silent failure.
 */
test("🛑 a MULTI-LINE prompt survives as ONE turn", () => {
  const h = harness();
  const prompt = "line one\nline two\n\nline four";

  h.send(prompt);

  assert.equal(h.turns.length, 1, "a multi-line prompt was split into turns");
  assert.equal(h.prompts[0], prompt);
});

test("the turn's stdout is passed through byte for byte", () => {
  const h = harness();

  h.send("go");
  h.turns[0].say('{"type":"system","subtype":"init","session_id":"s-1"}');

  assert.equal(
    h.written(),
    '{"type":"system","subtype":"init","session_id":"s-1"}\n',
  );
});

/**
 * Rows 1 and 2 of `per-turn.ts`'s table: a turn that ENDED, then exited, is a
 * clean turn and the agent lives.
 */
test("a turn that ends then exits leaves the relay alive for the next turn", () => {
  const h = harness();

  h.send("first");
  h.turns[0].say('{"type":"result","session_id":"s-1"}');
  h.turns[0].exit(0);

  assert.deepEqual(h.exits, [], "the relay exited on a CLEAN turn end");

  h.send("second");

  assert.equal(h.turns.length, 2);
  assert.equal(h.prompts[1], "second");
});

/**
 * 🛑 ROW 3, AND IT IS THE LOAD-BEARING ONE. `cursor-agent` without `--trust`
 * exits 1 having emitted zero events. The relay cannot route that to a turn
 * end, because the supervisor's queue would advance on a prompt that was never
 * answered. Exiting propagates it as the death it is.
 */
test("🛑 a turn that exits with NO turn end exits the relay, carrying the code", () => {
  const h = harness();

  h.send("go");
  h.turns[0].exit(1);

  assert.deepEqual(h.exits, [1]);
});

test("🔴 control — the same exit code after a turn end does NOT exit the relay", () => {
  const h = harness();

  h.send("go");
  h.turns[0].say('{"type":"result"}');
  h.turns[0].exit(1);

  assert.deepEqual(
    h.exits,
    [],
    "a non-zero exit AFTER a turn end is still a clean turn",
  );
});

/**
 * 🛑 THE SHAPE A LONG-LIVED CHILD HIDES. A partial line sits in the scanner's
 * buffer until the next chunk releases it, and a per-turn child has no next
 * chunk — so an unterminated final `result` is checked at exit or never.
 */
test("🛑 a final result line with NO trailing newline still ends the turn", () => {
  const h = harness();

  h.send("go");
  h.turns[0].sayPartial(JSON.stringify({ type: "result", session_id: "s" }));
  h.turns[0].exit(0);

  assert.deepEqual(
    h.exits,
    [],
    "an unterminated result line was missed, so a clean turn read as a death",
  );
});

test("frameTurn emits exactly one line, whatever the prompt contains", () => {
  const framed = frameTurn("a\nb\nc");

  assert.equal(framed.endsWith("\n"), true);
  assert.equal(framed.trimEnd().includes("\n"), false);
});

/**
 * 🛑 FINDING 1 ON PR 384, AND THE REGRESSION TEST FOR IT. The relay used to
 * regex the RAW TEXT for `"type":"result"`, while the supervisor PARSES and
 * reads the TOP-LEVEL `type`. A nested result satisfied the regex and not the
 * parse, which leaves the child gone, the container alive and the supervisor's
 * queue `inTurn` forever.
 */
test("🛑 a NESTED result does not end the turn, because the supervisor says it does not", () => {
  const h = harness();

  h.send("go");
  h.turns[0].say(
    JSON.stringify({ type: "assistant", payload: { type: "result" } }),
  );
  h.turns[0].exit(1);

  assert.deepEqual(
    h.exits,
    [1],
    "a nested result was read as a turn end, so the queue would wedge forever",
  );
});

/**
 * 🛑 WHY THE FIX IS A SHARED PREDICATE AND NOT "ANY OUTPUT AT ALL".
 * `routeCursorEvent` records that the init event is the FIRST line of the
 * stream, so a crash after init is a child that emitted output and no turn
 * end. Treating any byte as a turn end wedges exactly there — the likelier
 * case than the nested result above.
 */
test("🛑 output WITHOUT a turn end is still a death — init then crash", () => {
  const h = harness();

  h.send("go");
  h.turns[0].say(
    JSON.stringify({ type: "system", subtype: "init", session_id: "s-1" }),
  );
  h.turns[0].exit(1);

  assert.deepEqual(h.exits, [1]);
});

/**
 * 🛑 FINDING 2 ON PR 384. `Buffer.from(x, "base64")` ignores every character
 * outside the alphabet instead of throwing, so an unframed prompt decodes to
 * garbage and the agent answers something nobody wrote.
 */
test("🛑 an UNFRAMED line starts no turn and ends the relay loudly", () => {
  const h = harness();

  h.input.write("review PR 384 please\n");

  assert.equal(h.turns.length, 0, "a garbage prompt was handed to a turn");
  assert.deepEqual(h.exits, [UNFRAMED_PROMPT_EXIT]);
  assert.match(h.errors(), /not a framed prompt/);
});

test("🔴 control — unframeTurn accepts what frameTurn produced", () => {
  const prompt = "line one\nline two";

  assert.equal(unframeTurn(frameTurn(prompt)), prompt);
  assert.equal(unframeTurn("review PR 384 please"), null);
});

/**
 * 🛑 FINDING 3 ON PR 384. A spawn failure emits `error` and NO `exit`, so
 * without a handler the relay died of an uncaught exception and the supervisor
 * got node's status rather than the cause.
 */
test("🛑 a turn that fails to SPAWN exits the relay instead of throwing", () => {
  const h = harness();

  h.send("go");
  h.turns[0].fail(new Error("spawn cursor-agent ENOENT"));

  assert.deepEqual(h.exits, [1]);
  assert.match(h.errors(), /failed to start/);
});

/**
 * 🛑 WITHOUT A RESUME ID EVERY TURN IS A FRESH SESSION, so the agent forgets
 * the task between turns while looking like it is working. The relay is the
 * only party that can carry the id: the per-turn exits happen inside the
 * container, so the supervisor never sees them.
 */
test("🛑 turn two resumes the session turn one reported", () => {
  const h = harness();

  h.send("first");
  h.turns[0].say(
    JSON.stringify({ type: "system", subtype: "init", session_id: "s-1" }),
  );
  h.turns[0].say(JSON.stringify({ type: "result", session_id: "s-1" }));
  h.turns[0].exit(0);

  h.send("second");

  assert.equal(h.requests[0].resumeSessionId, undefined);
  assert.equal(h.requests[1].resumeSessionId, "s-1");
});

/**
 * ⚠️ THE FALLBACK IS NOT DEAD CODE, for the reason `host.ts` records: on turn
 * one no event has arrived, so the only id available is the one a RESTART was
 * asked to resume. Dropping it there is how a restarted agent loses its task.
 */
test("🛑 turn ONE resumes the id a restart was given", () => {
  const h = harness("s-restored");

  h.send("first");

  assert.equal(h.requests[0].resumeSessionId, "s-restored");
});

test("the LAST id a turn reports wins", () => {
  const h = harness();

  h.send("first");
  h.turns[0].say(JSON.stringify({ type: "system", session_id: "s-1" }));
  h.turns[0].say(JSON.stringify({ type: "result", session_id: "s-2" }));
  h.turns[0].exit(0);

  h.send("second");

  assert.equal(h.requests[1].resumeSessionId, "s-2");
});

/**
 * 🔴 CONTROL — a turn that reports NO id must not CLEAR the one already held.
 * Overwriting with undefined would silently drop the session on any turn whose
 * events omit the field.
 */
test("🔴 control — a turn reporting no id leaves the previous one in place", () => {
  const h = harness();

  h.send("first");
  h.turns[0].say(JSON.stringify({ type: "result", session_id: "s-1" }));
  h.turns[0].exit(0);

  h.send("second");
  h.turns[1].say(JSON.stringify({ type: "result" }));
  h.turns[1].exit(0);

  h.send("third");

  assert.equal(h.requests[2].resumeSessionId, "s-1");
});

/**
 * 🛑 TWO FRAMED PROMPTS IN ONE CHUNK USED TO START TWO TURNS AT ONCE, and both
 * symptoms are bad. The loud one is that their stdout interleaves into corrupt
 * JSON on the one stream the supervisor parses. The QUIET one is that turn two
 * gets `resume: undefined`, so the agent forgets the task — the exact bug this
 * relay exists to prevent, reappearing by another door.
 *
 * ⚠️ NOT REACHABLE THROUGH THE SUPERVISOR TODAY, and that is checked rather
 * than assumed: `index.ts` holds the only `child.send` call site tree-wide and
 * `TurnQueue.dispatch` sends only from `idle`. The guard is here because
 * the relay is a separate PROCESS from the queue that protects it, so the
 * contract is unstated on both sides. claude2 on PR 385.
 */
test("🛑 two framed prompts in ONE chunk start ONE turn, not two", () => {
  const h = harness();

  h.input.write(frameTurn("first") + frameTurn("second"));

  assert.equal(h.turns.length, 1);
  assert.deepEqual(h.prompts, ["first"]);
});

test("🛑 the queued prompt starts when the running turn exits", () => {
  const h = harness();

  h.input.write(frameTurn("first") + frameTurn("second"));
  h.turns[0].say(JSON.stringify({ type: "result", session_id: "s-1" }));
  h.turns[0].exit(0);

  assert.equal(h.turns.length, 2);
  assert.equal(h.prompts[1], "second");
});

/**
 * 🛑 THE QUIET HALF OF THE SAME BUG. Serialising is what makes `sessionId`
 * single-writer, so the queued turn resumes rather than starting fresh.
 */
test("🛑 a queued prompt resumes the session the turn before it reported", () => {
  const h = harness();

  h.input.write(frameTurn("first") + frameTurn("second"));
  h.turns[0].say(JSON.stringify({ type: "result", session_id: "s-1" }));
  h.turns[0].exit(0);

  assert.equal(h.requests[1].resumeSessionId, "s-1");
});

/**
 * 🔴 CONTROL — queueing must not DELAY a prompt that arrives while idle. A
 * guard that queued unconditionally would pass every test above and never
 * start turn one.
 */
test("🔴 control — a prompt arriving while idle starts immediately", () => {
  const h = harness();

  h.send("only");

  assert.equal(h.turns.length, 1);
});

/**
 * 🛑 A DEATH BEATS THE QUEUE. If the running turn exits with no turn end the
 * relay is gone, so a queued prompt must not be started into a dying relay.
 */
test("🛑 a queued prompt is NOT started when the running turn dies", () => {
  const h = harness();

  h.input.write(frameTurn("first") + frameTurn("second"));
  h.turns[0].exit(1);

  assert.equal(h.turns.length, 1, "a turn was started into a dying relay");
  assert.deepEqual(h.exits, [1]);
});

/**
 * 🛑 THE DROP NAMES ITSELF. The unframed path already refuses loudly, on the
 * same house rule: a dropped prompt that names itself beats a silent hang. A
 * death discarding a queued prompt is the same loss with no line to find it
 * by. claude2 on PR 385.
 */
test("🛑 a queued prompt discarded by a death is NAMED on stderr", () => {
  const h = harness();

  h.input.write(frameTurn("first") + frameTurn("second"));
  h.turns[0].exit(1);

  assert.match(h.errors(), /1 queued prompt/);
});

test("🔴 control — a death with NOTHING queued says nothing about a drop", () => {
  const h = harness();

  h.send("only");
  h.turns[0].exit(1);

  assert.equal(h.exits.length, 1, "the death itself was not propagated");
  assert.doesNotMatch(h.errors(), /queued prompt/);
});
