import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import {
  frameTurn,
  runTurnRelay,
} from "../../../src/supervise/drivers/turn-relay.js";

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
  };

  return turn;
}

interface Harness {
  readonly input: PassThrough;
  readonly written: () => string;
  readonly turns: FakeTurn[];
  readonly prompts: string[];
  readonly exits: (number | null)[];
  /** Feed one already-framed prompt, as the supervisor would. */
  send(prompt: string): void;
}

function harness(): Harness {
  const input = new PassThrough();
  const output = new PassThrough();
  let seen = "";
  output.on("data", (c: Buffer) => {
    seen += c.toString("utf8");
  });

  const turns: FakeTurn[] = [];
  const prompts: string[] = [];
  const exits: (number | null)[] = [];

  runTurnRelay({
    input,
    output,
    spawnTurn: (prompt: string) => {
      prompts.push(prompt);
      const turn = fakeTurn();
      turns.push(turn);

      return turn.proc;
    },
    exit: (code) => exits.push(code),
  });

  return {
    input,
    written: () => seen,
    turns,
    prompts,
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
