import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CHAT_MCP_HOME = mkdtempSync(
  join(tmpdir(), "chat-mcp-container-gate-"),
);

const { migrate } = await import("../../src/storage/db.js");
const { startSupervisor } = await import("../../src/supervise/index.js");
const { setToken } = await import("../../src/supervise/auth.js");
import { supervisorOptions } from "../support/supervisor-options.js";
import { confirmHandle } from "../support/confirm-plan.js";
const { overridePathFor, overridesDir } =
  await import("../../src/util/paths.js");

const DIRS = [process.cwd()];

function supervisorDb() {
  const db = new DatabaseSync(":memory:");
  migrate(db);
  return db;
}

test("a container supervisor with no token fails fast naming the fix", async () => {
  const db = supervisorDb();
  const handle = `cg-${process.pid}-notoken`;
  confirmHandle(handle);

  await assert.rejects(
    () =>
      startSupervisor(
        supervisorOptions({
          handle,
          db,
          extraDirs: DIRS,
          driver: "docker-claude",
          reply: false,
          log: () => undefined,
        }),
      ),
    /chat-mcp auth set-token/,
  );
});

test("an UNCONFIRMED container handle refuses to spawn without --now-style override", async () => {
  const db = supervisorDb();
  const handle = `cg-${process.pid}-unconfirmed`;
  setToken("sk-ant-oat-x");

  await assert.rejects(
    () =>
      startSupervisor(
        supervisorOptions({
          handle,
          db,
          extraDirs: DIRS,
          driver: "docker-claude",
          reply: false,
          log: () => undefined,
        }),
      ),
    /not confirmed/,
  );
});

test("a CONFIRMED handle with a token spawns via the docker driver", async () => {
  const db = supervisorDb();
  const handle = `cg-${process.pid}-ok`;
  setToken("sk-ant-oat-x");
  confirmHandle(handle);

  const spawned: unknown[] = [];
  const sup = await startSupervisor(
    supervisorOptions({
      handle,
      db,
      extraDirs: DIRS,
      driver: "docker-claude",
      reply: false,
      log: () => undefined,
      spawnChild: (opts) => {
        spawned.push(opts);
        return {
          reportsUsage: false,
          reportsContext: true,
          send: () => undefined,
          onTurnEnd: () => undefined,
          onContext: () => undefined,
          onUsage: () => undefined,
          onDenial: () => undefined,
          onSession: () => undefined,
          onEvent: () => undefined,
          onStderr: () => undefined,
          onExit: () => undefined,
          kill: () => undefined,
        };
      },
    }),
  );

  try {
    assert.equal(spawned.length, 1);
  } finally {
    await sup.stop();
  }
});

/* --------------------------------------------------------------------------
 * The gate COMPARES the plan. It used to latch a boolean per handle.
 * ----------------------------------------------------------------------- */

/**
 * 🔴 THE DEFECT THIS GATE EXISTS TO CLOSE. Approval used to be a boolean, so
 * an override or a mount added AFTER the operator said yes was shown to
 * nobody, ever — the banner described one container and a different one ran.
 *
 * 🛑 THE REFUSAL NAMES THE CHANGED FIELD. "the plan changed, approve it again"
 * makes the operator diff two banners by eye, and the field that matters is
 * the one they are least likely to spot.
 */
test("🔴 an override written AFTER the approval refuses the spawn and names the field", async () => {
  const db = supervisorDb();
  const handle = `cg-${process.pid}-drift`;
  setToken("sk-ant-oat-x");
  confirmHandle(handle);

  mkdirSync(overridesDir(), { recursive: true });
  writeFileSync(overridePathFor(handle), JSON.stringify({ memory: "512m" }));

  await assert.rejects(
    () =>
      startSupervisor(
        supervisorOptions({
          handle,
          db,
          extraDirs: DIRS,
          driver: "docker-claude",
          reply: false,
          log: () => undefined,
        }),
      ),
    /memory: no limit -> 512m \(dependency install: 1g\)/,
  );
});

/**
 * ⚠️ CONTROL — the gate is not refusing every container spawn. The same handle
 * approved AFTER the override starts, so the refusal above is the comparison
 * and not the override's mere presence.
 */
test("⚠️ control — the same override approved AFTER it was written spawns", async () => {
  const db = supervisorDb();
  const handle = `cg-${process.pid}-drift-ok`;
  setToken("sk-ant-oat-x");

  mkdirSync(overridesDir(), { recursive: true });
  writeFileSync(overridePathFor(handle), JSON.stringify({ memory: "512m" }));
  confirmHandle(handle);

  const spawned: unknown[] = [];
  const sup = await startSupervisor(
    supervisorOptions({
      handle,
      db,
      extraDirs: DIRS,
      driver: "docker-claude",
      reply: false,
      log: () => undefined,
      spawnChild: (opts) => {
        spawned.push(opts);
        return {
          reportsUsage: false,
          reportsContext: true,
          send: () => undefined,
          onTurnEnd: () => undefined,
          onContext: () => undefined,
          onUsage: () => undefined,
          onDenial: () => undefined,
          onSession: () => undefined,
          onEvent: () => undefined,
          onStderr: () => undefined,
          onExit: () => undefined,
          kill: () => undefined,
        };
      },
    }),
  );

  try {
    assert.equal(spawned.length, 1);
  } finally {
    await sup.stop();
  }
});

/**
 * 🛑 lee RULED A, 2026-11-20. A handle confirmed before the plan was recorded
 * carries `true` on disk, which compares to nothing. It re-prompts once rather
 * than adopting whatever plan it now sees.
 */
test("🛑 a legacy boolean approval refuses rather than adopting the current plan", async () => {
  const db = supervisorDb();
  const handle = `cg-${process.pid}-legacy`;
  setToken("sk-ant-oat-x");

  const statePath = join(process.env.CHAT_MCP_HOME!, "container.json");
  writeFileSync(
    statePath,
    JSON.stringify({ builtHash: null, confirmed: { [handle]: true } }),
  );

  await assert.rejects(
    () =>
      startSupervisor(
        supervisorOptions({
          handle,
          db,
          extraDirs: DIRS,
          driver: "docker-claude",
          reply: false,
          log: () => undefined,
        }),
      ),
    /is not confirmed/,
  );
});
