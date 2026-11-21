import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CURSOR_CONTAINER_BINARY,
  CURSOR_CONTAINER_HOME,
  CURSOR_HOST_BINARY,
  cursorArgs,
  cursorEncodeInput,
  cursorMissingClauses,
  cursorRedispatchPrompt,
  routeCursorEvent,
} from "../../src/supervise/drivers/cursor.js";
import { cursorSpawn } from "../../src/adapters/cursor-spawn.js";
import { claudeSpawn } from "../../src/adapters/claude-spawn.js";
import { spawnFor, vendorsWithSpawn } from "../../src/adapters/index.js";
import { resolveDriver } from "../../src/supervise/drivers/index.js";
import type { RateLimitSnapshot } from "../../src/supervise/rate-limit.js";
import type { ContextSnapshot } from "../../src/supervise/context-gauge.js";

/** Collect every sink call, so "was not called" is assertable. */
function recorder() {
  const calls: string[] = [];

  return {
    calls,
    on: {
      turnEnd: () => calls.push("turnEnd"),
      usage: (_s: RateLimitSnapshot) => calls.push("usage"),
      context: (_s: ContextSnapshot) => calls.push("context"),
      session: (id: string) => calls.push(`session:${id}`),
    },
  };
}

test("spawnFor resolves the cursor vendor, and it is not claude in disguise", () => {
  const vendor = spawnFor("cursor");

  assert.equal(vendor, cursorSpawn);
  assert.notEqual(
    vendor.binary,
    claudeSpawn.binary,
    "a silent fallback to claude is what this asserts against",
  );
});

test("vendorsWithSpawn now carries cursor beside claude", () => {
  assert.deepEqual([...vendorsWithSpawn()].sort(), ["claude", "cursor"]);
});

test("🛑 cursor-agent is spawned by ABSOLUTE path, because it is not on PATH", () => {
  assert.ok(
    CURSOR_HOST_BINARY.startsWith("/"),
    "a bare name exits 127 and reads as a dead agent, not a missing CLI",
  );
  assert.match(CURSOR_HOST_BINARY, /\/\.local\/bin\/cursor-agent$/);
  assert.equal(cursorSpawn.binary, CURSOR_HOST_BINARY);
});

test("🛑 the container binary path sits under the container HOME it declares", () => {
  assert.ok(
    CURSOR_CONTAINER_BINARY.startsWith(`${CURSOR_CONTAINER_HOME}/`),
    "the bus resolves its state dir from HOME; a binary outside it means the two disagree",
  );
  assert.equal(cursorSpawn.containerHome, CURSOR_CONTAINER_HOME);
});

test("🛑 cursor gets its OWN image, per lee's ruling of 2026-11-20", () => {
  assert.notEqual(
    cursorSpawn.image,
    claudeSpawn.image,
    "one image per vendor — the container is the security boundary",
  );
  assert.match(cursorSpawn.image, /cursor/);
});

test("🛑 a turn costs a process, so the per-turn wiring is selected", () => {
  assert.equal(cursorSpawn.processPerTurn, true);
  assert.equal(
    claudeSpawn.processPerTurn,
    false,
    "the control: the two vendors must disagree here or the field is decorative",
  );
});

test("🛑 cursorArgs carries the three flags that fail SILENTLY when absent", () => {
  const args = cursorArgs();

  // Each of these produces a clean exit with zero events when missing, which
  // the supervisor cannot tell apart from an agent with nothing to say.
  assert.ok(
    args.includes("--trust"),
    "without it: exit 1, Workspace Trust Required",
  );
  assert.ok(
    args.includes("--force"),
    "without it: tools are gated and nothing answers",
  );
  assert.ok(
    args.includes("--approve-mcps"),
    "without it: the bus servers stay unapproved",
  );

  assert.ok(args.includes("-p"));
  assert.deepEqual(
    args.slice(
      args.indexOf("--output-format"),
      args.indexOf("--output-format") + 2,
    ),
    ["--output-format", "stream-json"],
  );
});

test("cursorArgs passes model and resume only when asked", () => {
  assert.ok(!cursorArgs().includes("--model"));
  assert.ok(!cursorArgs().includes("--resume"));

  const args = cursorArgs({ model: "m-1", resumeSessionId: "s-1" });

  assert.deepEqual(args.slice(-4), ["--model", "m-1", "--resume", "s-1"]);
});

test("🛑 the flag set is the SAME in both sandbox modes, unlike claude's", () => {
  const host = cursorSpawn.argsFor({}, "host");
  const docker = cursorSpawn.argsFor({}, "docker");

  assert.deepEqual(host, docker);
  assert.notDeepEqual(
    claudeSpawn.argsFor({}, "host"),
    claudeSpawn.argsFor({}, "docker"),
    "the control: claude's two sets DO differ, so this assertion can fail",
  );
});

test("🛑 a result event ends the turn", () => {
  const r = recorder();

  routeCursorEvent({ type: "result" }, r.on);

  assert.deepEqual(r.calls, ["turnEnd"]);
});

test("🛑 a non-terminal event does NOT end the turn", () => {
  const r = recorder();

  routeCursorEvent({ type: "assistant" }, r.on);

  assert.deepEqual(r.calls, [], "an in-flight turn must stay in flight");
});

test("the session id is routed off the terminal event", () => {
  const r = recorder();

  routeCursorEvent({ type: "result", session_id: "sess-7" }, r.on);

  assert.deepEqual(r.calls, ["session:sess-7", "turnEnd"]);
});

/**
 * 🛑 THE PAIRED CASE, WITHOUT WHICH THE DOCBLOCK ABOVE `routeCursorEvent`
 * COULD BE WRONG AND NOTHING WOULD FAIL. Found by claude1 on PR 345: the
 * comment said the id "rides the terminal event", which is an observation of
 * one CLI build, while the code takes it off any event. Narrowing to
 * `type === "result"` is then an equivalent mutant against the test above.
 *
 * ⚠️ IT MUST NOT END THE TURN. A session id is not a turn boundary, and
 * routing both off one event is how an in-flight turn gets closed early.
 */
test("🛑 a session id on a NON-terminal event is routed, and does not end the turn", () => {
  const r = recorder();

  routeCursorEvent({ type: "assistant", session_id: "sess-9" }, r.on);

  assert.deepEqual(r.calls, ["session:sess-9"]);
});

/**
 * 🛑 THE MEASURED CASE, AND IT IS THE FIRST LINE OF A REAL STREAM. Copied from
 * a live cursor-agent 2026.11.19-f005e9d run: the init event carries the
 * session id before the prompt is even echoed back.
 *
 * ⚠️ THIS IS WHY THE ROUTING CANNOT BE TERMINAL-ONLY. A turn that crashes
 * after init would otherwise lose its id, and the grant stops being resumable
 * with nothing saying so. An earlier docblock claimed the id arrived only on
 * the result event; the live run says otherwise.
 */
test("🛑 the INIT event's session id is routed, measured against a live run", () => {
  const r = recorder();

  routeCursorEvent(
    {
      type: "system",
      subtype: "init",
      apiKeySource: "login",
      cwd: "/work",
      session_id: "2fb62aea-5657-4e6d-a70c-07d35e831a27",
      model: "Auto",
      permissionMode: "default",
    },
    r.on,
  );

  assert.deepEqual(r.calls, ["session:2fb62aea-5657-4e6d-a70c-07d35e831a27"]);
});

test("🔴 the usage and context sinks are NEVER called, matching both declarations", () => {
  // 🛑 #219 IS THE FAILURE THIS GUARDS. Declaring `reportsUsage: true` while
  // the router never calls the sink tells the operator a reading is coming and
  // leaves them waiting for it forever. The declaration and the router must
  // agree, so both halves are asserted together.
  assert.equal(cursorSpawn.reportsUsage, false);
  assert.equal(cursorSpawn.reportsContext, false);

  const r = recorder();

  // 🛑 THE FIELD NAMES ARE CURSOR'S OWN, COPIED FROM A LIVE RUN of
  // cursor-agent 2026.11.19-f005e9d. An earlier cut of this payload used
  // Claude Code's snake_case names and called them measured — they are
  // camelCase, there is no window total, and `reasoningTokens` has no Claude
  // equivalent. Nothing failed, because the point of the test is that the sink
  // stays SILENT, and a payload the router ignores is silent either way.
  //
  // ⚠️ WHICH IS WHY A WRONG SHAPE HERE IS WORTH CORRECTING RATHER THAN
  // SHRUGGING AT. The next person to wire `reportsUsage` reads this payload as
  // the contract.
  routeCursorEvent(
    {
      type: "result",
      subtype: "success",
      session_id: "s",
      usage: {
        inputTokens: 13918,
        outputTokens: 57,
        cacheReadTokens: 3968,
        cacheWriteTokens: 0,
        reasoningTokens: 56,
      },
    },
    r.on,
  );

  assert.ok(
    !r.calls.includes("usage"),
    "token counts are not a RateLimitSnapshot, so the sink must stay silent",
  );
  assert.ok(
    !r.calls.includes("context"),
    "no window TOTAL is reported, and used-without-total cannot make a percentage",
  );
  assert.ok(r.calls.includes("turnEnd"), "the control: this event WAS routed");
});

test("🛑 the prompt is sent raw, not wrapped in claude's stream-json envelope", () => {
  assert.equal(cursorEncodeInput("what is 2+2?"), "what is 2+2?");

  const wrapped = claudeSpawn.encodeInput("what is 2+2?");

  assert.match(wrapped, /"type":"user"/);
  assert.notEqual(
    cursorEncodeInput("what is 2+2?"),
    wrapped,
    "stdin IS the prompt here; an envelope would be asked as the question",
  );
});

test("cursor's alias pair resolves to the cursor vendor in both modes", () => {
  assert.deepEqual(resolveDriver({ driver: "cursor" }), {
    vendor: "cursor",
    mode: "host",
  });
  assert.deepEqual(resolveDriver({ driver: "docker-cursor" }), {
    vendor: "cursor",
    mode: "docker",
  });
});

test("🛑 --container tightens cursor, and docker-cursor cannot be loosened", () => {
  assert.deepEqual(resolveDriver({ driver: "cursor", container: true }), {
    vendor: "cursor",
    mode: "docker",
  });
  assert.deepEqual(
    resolveDriver({ driver: "docker-cursor", container: false }),
    {
      vendor: "cursor",
      mode: "docker",
    },
  );
});

test("🛑 cursor's re-dispatch prompt does not name a claude flag", () => {
  const prompt = cursorRedispatchPrompt({
    grantedCommand: "ls -la",
    followUp: "then continue.",
  });

  assert.ok(
    !prompt.includes("--allowedTools"),
    "that is claude's flag; cursor has no such thing",
  );
  assert.deepEqual(cursorMissingClauses(prompt), []);
  assert.match(prompt, /ls -la/);
});

test("🛑 an empty granted command throws instead of producing a useless prompt", () => {
  assert.throws(
    () => cursorRedispatchPrompt({ grantedCommand: "   ", followUp: "go" }),
    /verbatim/,
  );
});

test("🔴 control — dropping a required clause is caught on the way out", () => {
  // Proves the clause guard is live rather than decorative: a prompt missing
  // one clause is reported as missing exactly that one.
  assert.deepEqual(cursorMissingClauses("This is a NEW invocation."), [
    "now-permitted",
    "denial-superseded",
  ]);
});
