import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { wirePerTurnChild } from "../../../src/supervise/drivers/per-turn.js";
import { assertDeclaresProcessLifetime } from "../../../src/supervise/drivers/wiring.js";
import { spawnOnHost } from "../../../src/supervise/drivers/host.js";
import type { VendorSpawn } from "../../../src/supervise/vendor.js";

/**
 * 🛑 A CLI THAT EXITS EVERY TURN, DRIVEN BY A FAKE RATHER THAN BY CURSOR.
 *
 * `cursor-agent` costs money and is non-deterministic, which is why
 * `AgentChild` is an interface at all. The fake below replays the shape #317
 * measured: stdin read to EOF, a `{"type":"result"}` event, then exit.
 */

interface FakeProc {
  readonly proc: ChildProcessWithoutNullStreams;
  readonly stdinWrites: string[];
  stdinEnded: boolean;
  killed: boolean;
  say(line: string): void;
  sayErr(chunk: string): void;
  closeErr(): void;
  exit(code: number | null, signal?: string | null): void;
}

function fakeProc(): FakeProc {
  const stream = (): EventEmitter & { setEncoding: (e: string) => void } => {
    const s = new EventEmitter() as EventEmitter & {
      setEncoding: (e: string) => void;
    };
    s.setEncoding = () => undefined;

    return s;
  };

  const stdout = stream();
  const stderr = stream();
  const lifecycle = new EventEmitter();

  const fake: FakeProc = {
    proc: {
      stdout,
      stderr,
      stdin: {
        write: (chunk: string) => {
          fake.stdinWrites.push(chunk);

          return true;
        },
        end: () => {
          fake.stdinEnded = true;
        },
      },
      on: (event: string, cb: (...a: unknown[]) => void) => {
        lifecycle.on(event, cb);
      },
      kill: () => {
        fake.killed = true;
      },
    } as unknown as ChildProcessWithoutNullStreams,
    stdinWrites: [],
    stdinEnded: false,
    killed: false,
    say: (line: string) => stdout.emit("data", `${line}\n`),
    sayErr: (chunk: string) => stderr.emit("data", chunk),
    closeErr: () => stderr.emit("end"),
    exit: (code, signal = null) => lifecycle.emit("exit", code, signal),
  };

  return fake;
}

/** A vendor shaped like the one #317 measured: result ends the turn. */
const perTurnVendor: Pick<
  VendorSpawn,
  "routeEvent" | "encodeInput" | "reportsUsage" | "reportsContext"
> = {
  routeEvent: (event, on) => {
    const id = event.session_id;
    if (typeof id === "string" && on.session) on.session(id);

    if (event.type === "result") on.turnEnd();
  },
  encodeInput: (text: string) => text,
  reportsUsage: true,
  reportsContext: false,
};

interface Harness {
  readonly agent: ReturnType<typeof wirePerTurnChild>;
  readonly spawned: FakeProc[];
  readonly resumeIds: (string | undefined)[];
  readonly exits: { code: number | null; signal: string | null }[];
  readonly turnEnds: number[];
  readonly errLines: string[];
  readonly events: Record<string, unknown>[];
}

function harness(): Harness {
  const spawned: FakeProc[] = [];
  const resumeIds: (string | undefined)[] = [];
  const exits: { code: number | null; signal: string | null }[] = [];
  const turnEnds: number[] = [];
  const errLines: string[] = [];
  const events: Record<string, unknown>[] = [];

  const agent = wirePerTurnChild(({ resumeSessionId }) => {
    resumeIds.push(resumeSessionId);
    const next = fakeProc();
    spawned.push(next);

    return next.proc;
  }, perTurnVendor);

  agent.onExit((code, signal) => exits.push({ code, signal }));
  agent.onTurnEnd(() => turnEnds.push(spawned.length));
  agent.onStderr((l) => errLines.push(l));
  agent.onEvent((e) => events.push(e));

  return { agent, spawned, resumeIds, exits, turnEnds, errLines, events };
}

/** Turn N's normal life: a result event, then a clean exit. */
function finishTurn(p: FakeProc, sessionId: string): void {
  p.say(JSON.stringify({ type: "result", session_id: sessionId }));
  p.exit(0);
}

test("🛑 one process per turn, so a second send spawns a second process", () => {
  const h = harness();

  h.agent.send("first");
  assert.equal(h.spawned.length, 1);

  finishTurn(h.spawned[0], "sess-1");

  h.agent.send("second");
  assert.equal(
    h.spawned.length,
    2,
    "a per-turn CLI has already exited; writing to the old stdin answers nobody",
  );

  // The prompt IS the stdin, and the EOF is what starts the turn.
  assert.deepEqual(h.spawned[1].stdinWrites, ["second"]);
  assert.equal(h.spawned[1].stdinEnded, true);
});

test("🛑 turn two resumes the session turn one reported", () => {
  const h = harness();

  h.agent.send("first");
  finishTurn(h.spawned[0], "sess-abc");
  h.agent.send("second");

  assert.deepEqual(
    h.resumeIds,
    [undefined, "sess-abc"],
    "without the resume id every turn is a fresh agent with no memory of the task",
  );
});

test("🛑 a turn that ENDED before exiting is not a death — no onExit", () => {
  const h = harness();

  h.agent.send("first");
  finishTurn(h.spawned[0], "sess-1");

  assert.deepEqual(h.turnEnds, [1], "the turn ended exactly once");
  assert.deepEqual(
    h.exits,
    [],
    "onExit takes the handle offline and closes the socket; this agent is alive",
  );
});

test("🔴 a process that exits with NO turn end IS a death, and carries the code", () => {
  const h = harness();

  // `cursor-agent` without `--trust` exits 1 having emitted zero events.
  h.agent.send("first");
  h.spawned[0].exit(1);

  assert.deepEqual(h.turnEnds, [], "nothing ended the turn");
  assert.deepEqual(
    h.exits,
    [{ code: 1, signal: null }],
    "routing this to onTurnEnd instead leaves the queue waiting on a dead process forever",
  );
});

test("⚠️ a non-zero exit AFTER a clean turn is said out loud, not treated as a death", () => {
  const h = harness();

  h.agent.send("first");
  h.spawned[0].say(JSON.stringify({ type: "result", session_id: "s" }));
  h.spawned[0].exit(3);

  assert.deepEqual(h.exits, [], "the answer was delivered, so the agent lives");
  assert.equal(
    h.errLines.filter((l) => l.includes("code=3")).length,
    1,
    "a fault that repeats every turn while the queue reports success is invisible",
  );
});

test("🛑 stderr residue flushes at EVERY process end, not only the last", () => {
  const h = harness();

  h.agent.send("first");
  // No trailing newline: a process that dies mid-line never sends one.
  h.spawned[0].sayErr("turn one died here");
  h.spawned[0].closeErr();
  finishTurn(h.spawned[0], "sess-1");

  h.agent.send("second");
  h.spawned[1].sayErr("turn two died here");
  h.spawned[1].closeErr();

  assert.deepEqual(h.errLines, ["turn one died here", "turn two died here"]);
});

test("🛑 the fan-out outlives one process, so turn two's events still arrive", () => {
  const h = harness();

  h.agent.send("first");
  finishTurn(h.spawned[0], "sess-1");
  h.agent.send("second");
  h.spawned[1].say(JSON.stringify({ type: "assistant", turn: 2 }));

  assert.equal(
    h.events.filter((e) => e.turn === 2).length,
    1,
    "the supervisor subscribes once, at wiring time, and must keep receiving",
  );
});

test("🛑 kill() while idle still reports the agent gone", () => {
  const h = harness();

  h.agent.send("first");
  finishTurn(h.spawned[0], "sess-1");

  // Between turns there is no process at all, and nothing else takes the
  // handle offline or closes the socket.
  h.agent.kill();

  assert.equal(h.exits.length, 1);
  assert.equal(h.exits[0].signal, "SIGTERM");
});

test("🛑 send() after kill() spawns nothing", () => {
  const h = harness();

  h.agent.kill();
  h.agent.send("too late");

  assert.equal(
    h.spawned.length,
    0,
    "a process started after the kill would answer onto a bus row reading offline",
  );
});

test("🛑 kill() mid-turn reports the real code, not a synthesised one", () => {
  const h = harness();

  h.agent.send("first");
  h.agent.kill();

  assert.equal(h.spawned[0].killed, true);

  h.spawned[0].exit(null, "SIGTERM");

  assert.deepEqual(h.exits, [{ code: null, signal: "SIGTERM" }]);
});

test("🔴 control — a vendor that does not declare processPerTurn throws", () => {
  assert.throws(
    () =>
      assertDeclaresProcessLifetime(
        {} as unknown as Pick<VendorSpawn, "processPerTurn">,
      ),
    /processPerTurn/,
  );
});

test("🔴 control — spawnOnHost REFUSES an undeclared vendor before spawning", () => {
  // 🛑 THE GUARD MUST BE WIRED AT THE DECISION POINT, not merely exported.
  // The binary below does not exist, so a spawn attempt would be the bug this
  // asserts against — the throw has to come first.
  assert.throws(
    () =>
      spawnOnHost({
        ...perTurnVendor,
        binary: "/nonexistent/cursor-agent",
        image: "none",
        containerHome: "/root",
        authEnvVar: "NONE",
        argsFor: () => [],
        mcpConfigFor: () => "",
        mcpConfigFlags: () => [],
        redispatchPrompt: () => "",
      } as unknown as VendorSpawn),
    /processPerTurn/,
  );
});
