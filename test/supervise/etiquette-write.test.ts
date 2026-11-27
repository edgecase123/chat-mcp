import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CHAT_MCP_HOME = mkdtempSync(
  join(tmpdir(), "chat-mcp-etiquette-write-"),
);

const { migrate } = await import("../../src/storage/db.js");
const { startSupervisor } = await import("../../src/supervise/index.js");
const { setToken } = await import("../../src/supervise/auth.js");
const { ETIQUETTE_RULES, etiquetteBody } =
  await import("../../src/supervise/etiquette.js");
import { supervisorOptions } from "../support/supervisor-options.js";
import { confirmHandle } from "../support/confirm-plan.js";

/* ==========================================================================
 * 🛑 WHY THIS FILE EXISTS BESIDE `etiquette-agents-md.test.ts`. That one holds
 * the CONTENT and the drift guard as pure functions. This one holds the
 * WIRING: a perfect rules file nobody writes, or writes to the wrong
 * filesystem, is inert — and nothing in the other file can tell the two apart.
 *
 * 🛑 ITS PROJECT DIR IS A TEMP DIR, NEVER `process.cwd()`. The supervisor
 * writes into the directory it supervises, so a test pointed at the checkout
 * writes `ETIQUETTE.md` into the repo on every run. `.gitignore` covers that
 * for real use; a test that NEEDS the ignore to stay clean is testing the
 * ignore.
 * ========================================================================== */

function fakeChild(sent: string[]) {
  let endTurn: (() => void) | undefined;
  return {
    opts: undefined as unknown,
    reportsUsage: false,
    reportsContext: true,
    send: (t: string) => sent.push(t),
    onTurnEnd: (cb: () => void) => {
      endTurn = cb;
    },
    onContext: () => undefined,
    onUsage: () => undefined,
    onDenial: () => undefined,
    onToolCall: () => undefined,
    onSession: (cb: (id: string) => void) => cb("sess-1"),
    onEvent: () => undefined,
    onStderr: () => undefined,
    onExit: () => undefined,
    kill: () => undefined,
    finishTurn: () => endTurn?.(),
  };
}

/** A supervisor over a throwaway project directory, with its own log sink. */
async function rig(opts: { handle: string; send?: (t: string) => number }) {
  const db = new DatabaseSync(":memory:");
  migrate(db);
  const dir = mkdtempSync(join(tmpdir(), "chat-mcp-etq-proj-"));
  const sent: string[] = [];
  const logs: string[] = [];
  setToken("sk-ant-oat-x");
  confirmHandle(opts.handle);

  const sup = await startSupervisor(
    supervisorOptions({
      handle: opts.handle,
      db,
      extraDirs: [dir],
      cwd: dir,
      log: (line: string) => logs.push(line),
      spawnChild: () => {
        const c = fakeChild(sent);
        if (opts.send) c.send = opts.send;
        return c;
      },
    }),
  );

  return { sup, dir, sent, logs };
}

test("🔴 the supervisor writes ETIQUETTE.md into the project dir it supervises", async () => {
  const { sup, dir } = await rig({ handle: `etq-w-${process.pid}` });

  try {
    const path = join(dir, "ETIQUETTE.md");

    assert.ok(existsSync(path), `no etiquette file at ${path}`);
    assert.equal(readFileSync(path, "utf8"), etiquetteBody());
  } finally {
    await sup.stop();
  }
});

/**
 * 🛑 THE RULES' OWN WORDS, NOT JUST THE FILE'S EXISTENCE. An empty file at the
 * right path passes `existsSync` and teaches the agent nothing.
 */
test("🔴 the written file carries every rule, read back off the disk", async () => {
  const { sup, dir } = await rig({ handle: `etq-c-${process.pid}` });

  try {
    const body = readFileSync(join(dir, "ETIQUETTE.md"), "utf8");

    for (const { rule } of ETIQUETTE_RULES) {
      assert.ok(body.includes(rule), `the file on disk omits: ${rule}`);
    }
  } finally {
    await sup.stop();
  }
});

/**
 * 🛑 ONE OFFER, NOT TWO, AND THIS IS THE TEST THAT PINS IT. Each offer is its
 * own turn. PR 469 measured the cost of a spare one: the pointer turn consumed
 * the turn a context-gate restart needed for its notice, and the suite went
 * red at 33 failures from that single cause.
 */
test("🛑 the handoff and the etiquette pointer ride ONE turn, not two", async () => {
  const { sup, sent } = await rig({ handle: `etq-t-${process.pid}` });

  try {
    assert.equal(sent.length, 1, `the preamble took ${sent.length} turns`);
    assert.match(sent[0] ?? "", /HANDOFF\.md/);
    assert.match(sent[0] ?? "", /ETIQUETTE\.md/);
  } finally {
    await sup.stop();
  }
});

/**
 * 🚨 claude1's FINDING, 2026-11-26: the `try/catch` around the offer had ZERO
 * tests — nothing matched its log string and nothing made the offer throw. A
 * longer preamble makes that swallow MORE likely to matter, so extending the
 * call site is what makes the test the author's.
 *
 * 🛑 BOTH HALVES OR IT IS VACUOUS. The log line alone does not show the
 * supervisor survived, and surviving alone does not show anybody was told.
 */
test("🚨 a throwing child is LOGGED and the supervisor still starts", async () => {
  const { sup, logs, dir } = await rig({
    handle: `etq-throw-${process.pid}`,
    send: (): number => {
      throw new Error("stdin is gone");
    },
  });

  try {
    assert.ok(sup, "the supervisor did not start");
    assert.ok(
      logs.some((l) => l.includes("FAILED to offer the handoff pointer")),
      `the swallow was silent. logs:\n${logs.join("\n")}`,
    );
    // 🛑 THE WRITE MUST STILL HAVE HAPPENED. It runs BEFORE the offer, so a
    // failed offer must not take the rules file with it.
    assert.ok(
      existsSync(join(dir, "ETIQUETTE.md")),
      "a failed offer lost the rules file too",
    );
  } finally {
    await sup.stop();
  }
});

/**
 * 🚨 THE WRITE'S OWN SWALLOW, held to the same bar. A read-only project
 * directory must not stop a supervisor, and it must not do so silently.
 */
test("🚨 an unwritable project dir is LOGGED and the supervisor still starts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chat-mcp-etq-ro-"));
  const db = new DatabaseSync(":memory:");
  migrate(db);
  const handle = `etq-ro-${process.pid}`;
  const logs: string[] = [];
  setToken("sk-ant-oat-x");
  confirmHandle(handle);
  chmodSync(dir, 0o500);

  let sup;
  try {
    sup = await startSupervisor(
      supervisorOptions({
        handle,
        db,
        extraDirs: [dir],
        cwd: dir,
        log: (line: string) => logs.push(line),
        spawnChild: () => fakeChild([]),
      }),
    );

    assert.ok(sup, "the supervisor did not start");
    assert.ok(
      logs.some((l) => l.includes("FAILED to write the etiquette file")),
      `the write's swallow was silent. logs:\n${logs.join("\n")}`,
    );
  } finally {
    chmodSync(dir, 0o700);
    await sup?.stop();
  }
});
