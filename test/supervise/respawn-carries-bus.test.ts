import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 🛑 BEFORE any import that resolves a state path, or the supervisor binds a
// socket inside the OPERATOR'S LIVE ~/.chat-mcp.
process.env.CHAT_MCP_HOME = mkdtempSync(
  join(tmpdir(), "chat-mcp-respawn-bus-"),
);

const { migrate } = await import("../../src/storage/db.js");
const { startSupervisor } = await import("../../src/supervise/index.js");
const { deliverToSupervisor } = await import("../../src/supervise/socket.js");
const { claudeSpawn } = await import("../../src/adapters/claude-spawn.js");
const { setToken } = await import("../../src/supervise/auth.js");
const { markConfirmed } = await import("../../src/supervise/container.js");
import type { AgentChild, SpawnOptions } from "../../src/supervise/child.js";

/**
 * 🛑 A CONTAINERIZED RESPAWN USED TO DROP `bus` AND THE AGENT DIED.
 *
 * `hostBus` is a local in `startSupervisor`, not a member of `opts`, so the
 * `...opts` spread that both respawn paths use does not carry it. Only the
 * first spawn named `bus:` explicitly. `containerized.ts` then refuses a
 * granted spawn with no endpoint, the throw left NO agent running, and the
 * socket file stayed behind so the handle still looked alive.
 *
 * ⚠️ `bus` IS OPTIONAL ON `SpawnOptions`, so omitting it typechecks clean.
 * `npm run typecheck` could never have said no.
 *
 * 🛑 THE EXISTING RESPAWN TESTS COULD NOT HAVE SAID NO EITHER. Their fake
 * `spawnChild` only chooses whether to THROW; it never inspects the options it
 * was handed, so a respawn carrying `bus` and one omitting it are the same run.
 * These tests assert the options.
 *
 * Both assert EQUALITY WITH THE FIRST SPAWN rather than mere presence, and
 * each one first asserts the first spawn's endpoint is defined — without that
 * control, `undefined === undefined` passes on the broken code.
 */
function recordingChild(children: SpawnOptions[]) {
  return (opts: SpawnOptions): AgentChild => {
    children.push(opts);

    return {
      reportsUsage: false,
      reportsContext: true,
      send: () => undefined,
      onTurnEnd: () => undefined,
      onContext: () => undefined,
      onUsage: () => undefined,
      onDenial: () => undefined,
      onSession: (cb) => cb("sess-from-fake"),
      onEvent: () => undefined,
      onStderr: () => undefined,
      onExit: () => undefined,
      kill: () => undefined,
    };
  };
}

async function containerSupervisor(handle: string, children: SpawnOptions[]) {
  const db = new DatabaseSync(":memory:");
  migrate(db);

  // The container gate, satisfied in the temp CHAT_MCP_HOME above — not the
  // operator's real one.
  setToken("sk-ant-oat-x");
  markConfirmed(handle);

  const sup = await startSupervisor({
    handle,
    vendor: claudeSpawn,
    db,
    extraDirs: [process.cwd()],
    // 🛑 THE FLAG THAT OPENS `hostBus` AT ALL. Without it the first spawn has
    // no endpoint either and every assertion below is vacuous.
    container: true,
    spawnChild: recordingChild(children),
    log: () => undefined,
  });

  return { sup, db };
}

async function deliver(
  handle: string,
  envelope: Record<string, unknown>,
): Promise<void> {
  await deliverToSupervisor(handle, {
    id: Number(envelope.id),
    to: handle,
    from: "lee",
    ts: Date.now(),
    ...envelope,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any).then(
    () => undefined,
    () => undefined,
  );
}

test("🚨 a RESTART respawn carries the bus endpoint the first spawn got", async () => {
  const children: SpawnOptions[] = [];
  const handle = `bus-${process.pid}-restart`;
  const { sup } = await containerSupervisor(handle, children);

  try {
    // The non-vacuity control: without an endpoint on call 1 there is nothing
    // for call 2 to lose.
    assert.ok(
      children[0]?.bus,
      "the first containerized spawn got no bus endpoint, so this test proves nothing",
    );

    await deliver(handle, { id: 1, control: { kind: "restart", mode: "now" } });

    assert.equal(children.length, 2, "the restart did not respawn");
    assert.deepEqual(
      children[1]?.bus,
      children[0]?.bus,
      "the restart respawn dropped the bus endpoint, so a real containerized spawn would refuse",
    );
  } finally {
    await sup.stop();
  }
});

test("🚨 an APPROVAL replacement carries the bus endpoint the first spawn got", async () => {
  const children: SpawnOptions[] = [];
  const handle = `bus-${process.pid}-approve`;
  const { sup } = await containerSupervisor(handle, children);

  try {
    assert.ok(
      children[0]?.bus,
      "the first containerized spawn got no bus endpoint, so this test proves nothing",
    );

    await deliver(handle, {
      id: 1,
      approval: {
        approvalId: 1,
        decision: "approve" as const,
        requested: "rm in '/tmp/x.txt'",
        grant: "Bash(rm -f /tmp/x.txt)",
        sessionId: "sess-1",
      },
    });

    assert.equal(children.length, 2, "the approval did not replace the child");
    assert.deepEqual(
      children[1]?.bus,
      children[0]?.bus,
      "the approval replacement dropped the bus endpoint, so approving a command would kill the agent",
    );
  } finally {
    await sup.stop();
  }
});

/**
 * 🛑 THE CLASS, NOT THE TWO INSTANCES. The tests above pin `bus` at the two
 * sites that exist today. A FOURTH `spawnFn({` added later, omitting `bus`,
 * passes both of them — and `bus` is optional on `SpawnOptions`, so typecheck
 * stays clean, exactly as it did for this bug. Raised by claude2 on review.
 *
 * The class is "a local that is not in `opts` is silently dropped by the
 * `...opts` spread", and `hostBus` was one instance of it.
 *
 * 🛑 THE SPLITTER IS THE PART THAT CAN LIE, so it is tested before it is
 * trusted. A guard that slices a block to the FIRST `}` launders a missed
 * writer into its neighbour's block — a real finding on #301, fixed there with
 * brace depth. `spawnFnBlocks` tracks depth, and `the splitter does not stop
 * at the first inner brace` below feeds it a shape it would fail on if it did.
 *
 * 🛑 THAT SECOND TEST IS NOT REDUNDANT, AND MEASURING IT PROVED SO. Degrading
 * this splitter to first-brace leaves the call-site guard below PASSING,
 * because no `spawnFn({` block in `index.ts` currently contains a nested
 * brace. The day one does — an inline `env: { … }` above `bus:` — a broken
 * splitter would truncate before the key and report a clean file. The two
 * tests are separate because the real source cannot yet exercise the nesting.
 */
function spawnFnBlocks(src: string): string[] {
  const ANCHOR = "spawnFn({";
  const blocks: string[] = [];
  let from = 0;

  for (;;) {
    const at = src.indexOf(ANCHOR, from);

    if (at === -1) break;

    // Start on the `{` that ANCHOR ends with, so depth opens at 1.
    let depth = 0;
    let end = -1;

    for (let i = at + ANCHOR.length - 1; i < src.length; i += 1) {
      if (src[i] === "{") depth += 1;
      else if (src[i] === "}") {
        depth -= 1;

        if (depth === 0) {
          end = i;
          break;
        }
      }
    }

    // An unbalanced block is a splitter failure, not an empty result. Push a
    // marker the assertions below cannot read as a pass.
    blocks.push(end === -1 ? `UNBALANCED:${ANCHOR}` : src.slice(at, end + 1));
    from = end === -1 ? at + ANCHOR.length : end + 1;
  }

  return blocks;
}

test("🛑 the splitter does not stop at the first inner brace", () => {
  // A nested object before the key, and a `}` that closes only the nest. A
  // first-`}` splitter returns the short block and never sees `bus:`.
  const nested = `spawnFn({\n  env: { A: 1 },\n  bus: endpoint,\n});`;
  const [block] = spawnFnBlocks(nested);

  assert.ok(block, "the splitter found no block at all");
  assert.match(block!, /bus:/, "the splitter stopped at the nested brace");

  // The positive half: it must also STOP, not run to the end of the input.
  const twoCalls = `${nested}\nspawnFn({ second: true });`;
  const blocks = spawnFnBlocks(twoCalls);

  assert.equal(blocks.length, 2, "the splitter did not find both calls");
  assert.doesNotMatch(
    blocks[0]!,
    /second/,
    "the first block ran on into the second call",
  );
  assert.ok(
    !blocks.some((b) => b.startsWith("UNBALANCED:")),
    "the splitter reported an unbalanced block on balanced input",
  );
});

test("🚨 every spawnFn call site passes bus, and there are exactly 3", () => {
  const src = readFileSync(
    new URL("../../src/supervise/index.ts", import.meta.url),
    "utf8",
  );
  const blocks = spawnFnBlocks(src);

  // 🛑 THE DENOMINATOR, PRINTED. A fourth site is a deliberate decision, and
  // whoever adds one updates this number having read the rule above it.
  assert.equal(
    blocks.length,
    3,
    `expected 3 spawnFn call sites, found ${blocks.length} — a new one must pass bus too`,
  );

  // 🛑 THE ANCHOR ONLY SEES AN INLINE OBJECT, so `spawnFn(someOpts)` is
  // invisible to it AND does not move the count — the hole is silent rather
  // than loud. MEASURED: a fourth site passing a variable passed 4 of 4
  // before this line. Raised by claude2 on review, one level deeper than the
  // 🟡 that produced the guard above.
  const everyCall = src.match(/spawnFn\(/g) ?? [];

  assert.equal(
    everyCall.length,
    blocks.length,
    `${everyCall.length} spawnFn( calls but only ${blocks.length} inspectable blocks — a call site passes a variable and nothing checks its bus`,
  );

  for (const block of blocks) {
    assert.ok(
      !block.startsWith("UNBALANCED:"),
      "a spawnFn block never closed; the splitter cannot be trusted here",
    );
    assert.match(
      block,
      /\bbus:/,
      `a spawnFn call site omits bus, so a containerized spawn with a grant would refuse: ${block.slice(0, 120)}`,
    );
  }
});
