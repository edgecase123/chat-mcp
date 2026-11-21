import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import {
  RELAY_USAGE_EXIT,
  relayDepsFromProcess,
  relayMain,
  type RelayProcess,
  type RelayVendor,
} from "../../src/relay/main.js";
import { routeCursorEvent } from "../../src/supervise/drivers/cursor.js";
import { cursorResumeFlags } from "../../src/supervise/drivers/cursor.js";
import { frameTurn } from "../../src/supervise/drivers/turn-relay.js";

/**
 * 🛑 THE ENTRYPOINT IS DRIVEN WITH A FAKE SPAWNER, BECAUSE A REAL TURN COSTS
 * MONEY. `relayMain` takes its spawner, its streams, its exit and its vendor
 * lookup as parameters for exactly that reason — and because `src/index.ts`
 * runs its CLI at import, which is #359 and must not be repeated here.
 */

interface FakeTurn {
  readonly proc: ChildProcessWithoutNullStreams;
  stdin: string;
  say(line: string): void;
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
        end: () => undefined,
      },
      on: (event: string, fn: (...a: unknown[]) => void) => {
        lifecycle.on(event, fn);

        return turn.proc;
      },
    } as unknown as ChildProcessWithoutNullStreams,
    stdin: "",
    say: (line: string) => stdout.emit("data", `${line}\n`),
    exit: (code: number | null) => lifecycle.emit("exit", code, null),
  };

  return turn;
}

const CURSOR: RelayVendor = {
  routeEvent: routeCursorEvent,
  resumeFlags: cursorResumeFlags,
};

interface Harness {
  readonly input: PassThrough;
  readonly errors: () => string;
  readonly turns: FakeTurn[];
  readonly argvs: string[][];
  readonly exits: (number | null)[];
  send(prompt: string): void;
}

function harness(
  argv: readonly string[],
  vendor: RelayVendor = CURSOR,
): Harness {
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume();

  const errorOutput = new PassThrough();
  let errors = "";
  errorOutput.on("data", (c: Buffer) => {
    errors += c.toString("utf8");
  });

  const turns: FakeTurn[] = [];
  const argvs: string[][] = [];
  const exits: (number | null)[] = [];

  relayMain(argv, {
    input,
    output,
    errorOutput,
    spawn: (binary: string, args: readonly string[]) => {
      argvs.push([binary, ...args]);
      const turn = fakeTurn();
      turns.push(turn);

      return turn.proc;
    },
    exit: (code) => exits.push(code),
    resolveVendor: () => vendor,
  });

  return {
    input,
    errors: () => errors,
    turns,
    argvs,
    exits,
    send: (prompt: string) => input.write(frameTurn(prompt)),
  };
}

function fakeProcess(): RelayProcess & { exits: (number | null)[] } {
  const exits: (number | null)[] = [];

  return {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exit: (code: number) => {
      exits.push(code);
    },
    exits,
  };
}

const BASE = ["--vendor", "cursor", "--", "cursor-agent", "-p", "--force"];

test("🛑 a turn runs the BASE argv, and the prompt is NOT in it", () => {
  const h = harness(BASE);

  h.send("review PR 386");

  assert.deepEqual(h.argvs, [["cursor-agent", "-p", "--force"]]);
  assert.equal(h.turns[0]?.stdin, "review PR 386");
});

test("🛑 turn two appends the VENDOR's resume flags for the id turn one reported", () => {
  const h = harness(BASE);

  h.send("one");
  h.turns[0]?.say('{"type":"system","session_id":"SESS-A"}');
  h.turns[0]?.say('{"type":"result"}');
  h.turns[0]?.exit(0);
  h.send("two");

  assert.deepEqual(h.argvs[1], [
    "cursor-agent",
    "-p",
    "--force",
    "--resume",
    "SESS-A",
  ]);
});

test("🛑 a relay started with --resume resumes on turn ONE", () => {
  const h = harness([
    "--vendor",
    "cursor",
    "--resume",
    "SESS-RESTART",
    "--",
    "cursor-agent",
    "-p",
  ]);

  h.send("one");

  assert.deepEqual(h.argvs[0], [
    "cursor-agent",
    "-p",
    "--resume",
    "SESS-RESTART",
  ]);
});

test("🛑 an argv with no --vendor REFUSES by name and starts no turn", () => {
  const h = harness(["--", "cursor-agent", "-p"]);

  assert.equal(h.turns.length, 0);
  assert.deepEqual(h.exits, [RELAY_USAGE_EXIT]);
  assert.match(h.errors(), /--vendor/);
});

test("🛑 an argv with no command after -- REFUSES by name and starts no turn", () => {
  const h = harness(["--vendor", "cursor"]);

  assert.equal(h.turns.length, 0);
  assert.deepEqual(h.exits, [RELAY_USAGE_EXIT]);
  assert.match(h.errors(), /command/);
});

/**
 * 🔴 CONTROL — the VENDOR's router is what decides a turn end, not a matcher
 * inside the relay. A router that never reports one turns a clean exit 0 into
 * a death, which is visible in `exits`.
 */
test("🔴 control — the injected routeEvent is the one that decides a turn end", () => {
  const h = harness(BASE, {
    routeEvent: () => undefined,
    resumeFlags: cursorResumeFlags,
  });

  h.send("one");
  h.turns[0]?.say('{"type":"result"}');
  h.turns[0]?.exit(0);

  assert.deepEqual(h.exits, [0], "a router that saw no turn end was ignored");
});

/**
 * 🛑 THE PROCESS WIRING IS TESTED HERE, BECAUSE `bin.ts` CANNOT BE. An
 * executable runs at import, so the only way its wiring is covered is by it
 * holding no decisions at all — every one of them is in this factory.
 */
test("🛑 the process wiring sends events to stdout and operator text to stderr", () => {
  const proc = fakeProcess();
  const deps = relayDepsFromProcess(
    proc,
    () => CURSOR,
    () => {
      throw new Error("not spawned in this test");
    },
  );

  assert.equal(deps.input, proc.stdin);
  assert.equal(deps.output, proc.stdout);
  assert.equal(deps.errorOutput, proc.stderr);
});

test("🛑 a turn killed by a SIGNAL does not exit the container 0", () => {
  const proc = fakeProcess();
  const deps = relayDepsFromProcess(
    proc,
    () => CURSOR,
    () => {
      throw new Error("not spawned in this test");
    },
  );

  deps.exit(null);

  assert.deepEqual(proc.exits, [1]);
});

test("🔴 control — a real exit code is passed through unchanged", () => {
  const proc = fakeProcess();
  const deps = relayDepsFromProcess(
    proc,
    () => CURSOR,
    () => {
      throw new Error("not spawned in this test");
    },
  );

  deps.exit(0);
  deps.exit(7);

  assert.deepEqual(proc.exits, [0, 7]);
});

test("🛑 a turn is spawned with all three streams piped", () => {
  const proc = fakeProcess();
  const calls: { binary: string; args: readonly string[]; stdio: unknown }[] =
    [];
  const deps = relayDepsFromProcess(
    proc,
    () => CURSOR,
    (binary, args, options) => {
      calls.push({ binary, args, stdio: options.stdio });

      return fakeTurn().proc;
    },
  );

  deps.spawn("cursor-agent", ["-p"]);

  assert.deepEqual(calls[0]?.stdio, ["pipe", "pipe", "pipe"]);
  assert.equal(calls[0]?.binary, "cursor-agent");
});
