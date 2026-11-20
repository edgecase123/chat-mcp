import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), "chat-mcp-ovr-seam-"));

const { migrate } = await import("../../src/storage/db.js");
const { startSupervisor } = await import("../../src/supervise/index.js");
const { deliverToSupervisor } = await import("../../src/supervise/socket.js");
const { overridesDir, overridePathFor } =
  await import("../../src/util/paths.js");
const { setToken } = await import("../../src/supervise/auth.js");
const { markConfirmed } = await import("../../src/supervise/container.js");
import { supervisorOptions } from "../support/supervisor-options.js";

import type { ContainerOverride } from "../../src/supervise/overrides.js";
import type { SpawnOptions } from "../../src/supervise/child.js";

const DIRS = [process.cwd()];

/**
 * #222's spawn seam. The reader shipped in PR 334 and nothing called it, so
 * every file an operator wrote changed no container.
 *
 * 🛑 THE SEAM IS THE ONE `spawnFn` WRAPPER, NOT THE CALL SITES. The child is
 * spawned in three places — first start, restart, replace — and the wrapper
 * already carries the comment saying why a guard repeated three times becomes
 * two. An override injected per call site has the same decay.
 */

/** Every `SpawnOptions` the supervisor handed a driver, in call order. */
function recordingChild(seen: SpawnOptions[]) {
  return (opts: SpawnOptions) => {
    seen.push(opts);

    return {
      reportsUsage: false,
      reportsContext: true,
      send: () => undefined,
      onTurnEnd: () => undefined,
      onContext: () => undefined,
      onUsage: () => undefined,
      onDenial: () => undefined,
      onSession: (cb: (id: string) => void) => cb("sess-1"),
      onEvent: () => undefined,
      onStderr: () => undefined,
      onExit: () => undefined,
      kill: () => undefined,
    };
  };
}

/**
 * 🛑 `mkdirSync` IS NOT OPTIONAL. `overrideStore` creates neither directory on
 * purpose — a reader that makes what it is about to read cannot tell "no
 * capabilities configured" from "the operator's file is in the wrong tree".
 */
function writeOverride(handle: string, body: unknown): void {
  mkdirSync(overridesDir(), { recursive: true });
  writeFileSync(overridePathFor(handle), JSON.stringify(body));
}

function supervisorFor(
  handle: string,
  seen: SpawnOptions[],
  extra: { container?: boolean; log?: (line: string) => void } = {},
) {
  const db = new DatabaseSync(":memory:");
  migrate(db);

  return startSupervisor(
    supervisorOptions({
      handle,
      db,
      extraDirs: DIRS,
      spawnChild: recordingChild(seen),
      log: extra.log ?? (() => undefined),
      container: extra.container,
    }),
  );
}

test("the handle's resolved override reaches the first spawn", async () => {
  const seen: SpawnOptions[] = [];
  const handle = `ovr-${process.pid}-first`;
  writeOverride(handle, { memory: "512m", cpus: "1.5" });

  const sup = await supervisorFor(handle, seen);

  try {
    assert.deepEqual(seen[0]?.containerOverride, {
      memory: "512m",
      cpus: "1.5",
    } satisfies ContainerOverride);
  } finally {
    await sup.stop();
  }
});

/**
 * 🛑 THE RESTART IS THE TEST THAT MATTERS, because it is the call site an
 * injection at the first spawn alone would miss. A handle restarted for a full
 * context would come back UNCAPPED, with the operator's file still on disk and
 * nothing reporting the change.
 */
test("🛑 a RESTARTED child carries the same override, not the default container", async () => {
  const seen: SpawnOptions[] = [];
  const handle = `ovr-${process.pid}-restart`;
  writeOverride(handle, { memory: "512m" });

  const sup = await supervisorFor(handle, seen);

  try {
    const ack = await deliverToSupervisor(handle, {
      id: 1,
      to: handle,
      from: "cli",
      ts: Date.now(),
      control: { kind: "restart", mode: "now" },
    });

    assert.equal(ack?.ok, true);
    assert.equal(seen.length, 2, "no replacement child was spawned");
    assert.deepEqual(seen[1]?.containerOverride, { memory: "512m" });
  } finally {
    await sup.stop();
  }
});

/**
 * The paired control. Most handles want the default container, and a seam that
 * invented an empty object would make "configured nothing" indistinguishable
 * from "configured, and it resolved to nothing".
 */
test("a handle with no override file spawns with null, not an empty object", async () => {
  const seen: SpawnOptions[] = [];
  const handle = `ovr-${process.pid}-none`;

  const sup = await supervisorFor(handle, seen);

  try {
    assert.equal(seen[0]?.containerOverride, null);
  } finally {
    await sup.stop();
  }
});

/**
 * 🛑 THE REFUSAL IS AT START, NOT AT THE SPAWN. A malformed file read inside
 * `spawnFn` would throw on a RESTART — which kills the child before it
 * respawns, leaving the handle with no agent and no remedy short of restarting
 * the supervisor. The same reasoning is already recorded on the cold-install
 * ordering in `startSupervisor`.
 */
test("🛑 a malformed override refuses the START, and spawns nothing", async () => {
  const seen: SpawnOptions[] = [];
  const handle = `ovr-${process.pid}-broken`;
  mkdirSync(overridesDir(), { recursive: true });
  writeFileSync(overridePathFor(handle), "{ not json");

  // 🛑 THE START IS STOPPED IF IT SUCCEEDS, OR THIS TEST HANGS INSTEAD OF
  // FAILING. `startSupervisor` binds a unix socket, so a supervisor nobody
  // stops keeps the test runner's event loop alive forever — and a 120s hang
  // reads as an infrastructure problem rather than as this assertion.
  let started: Awaited<ReturnType<typeof supervisorFor>> | undefined;

  try {
    started = await supervisorFor(handle, seen);
  } catch (err) {
    assert.match(String(err), /not json|cannot read/);
  }

  try {
    assert.equal(started, undefined, "a malformed override still started");
    assert.equal(seen.length, 0, "a refused start still spawned a child");
  } finally {
    await started?.stop();
  }
});

/**
 * 🛑 EVERY OVERRIDE KEY IS A `docker run` FLAG, SO A HOST SPAWN CAN HONOUR
 * NONE OF THEM. Without this line the operator's file sits on disk looking
 * effective while the agent runs with no limit on it — the same silent class
 * the rest of this unit exists to remove. Raised by claude2 reviewing PR 337.
 *
 * ⚠️ IT WARNS RATHER THAN REFUSING, deliberately. Refusing would make a mode
 * switch break a handle that is configured for the mode it is going back to.
 */
test("🛑 a VALID override on a HOST handle is reported, not dropped in silence", async () => {
  const seen: SpawnOptions[] = [];
  const lines: string[] = [];
  const handle = `ovr-${process.pid}-host`;
  writeOverride(handle, { memory: "512m" });

  const sup = await supervisorFor(handle, seen, {
    log: (line) => lines.push(line),
  });

  try {
    assert.equal(
      lines.filter((l) => l.includes("not running in a container")).length,
      1,
      `no host-mode warning in ${JSON.stringify(lines)}`,
    );
  } finally {
    await sup.stop();
  }
});

/**
 * The paired control. A warning printed for a CONTAINERIZED handle would tell
 * every correctly configured operator their override does not apply.
 */
test("a containerized handle with the same override is NOT warned about", async () => {
  const seen: SpawnOptions[] = [];
  const lines: string[] = [];
  const handle = `ovr-${process.pid}-docker`;
  writeOverride(handle, { memory: "512m" });

  // Container mode refuses to start without a token and without a confirmed
  // plan. This test is about the warning, not about either precondition.
  setToken("sk-ant-oat-x");
  markConfirmed(handle);

  const sup = await supervisorFor(handle, seen, {
    container: true,
    log: (line) => lines.push(line),
  });

  try {
    assert.deepEqual(
      lines.filter((l) => l.includes("not running in a container")),
      [],
    );
    assert.deepEqual(seen[0]?.containerOverride, { memory: "512m" });
  } finally {
    await sup.stop();
  }
});

/**
 * The second control, on the other axis. A warning keyed on the MODE alone
 * would fire for every host handle on the machine, which is almost all of
 * them.
 */
test("a host handle with NO override file is not warned about either", async () => {
  const seen: SpawnOptions[] = [];
  const lines: string[] = [];
  const handle = `ovr-${process.pid}-host-clean`;

  const sup = await supervisorFor(handle, seen, {
    log: (line) => lines.push(line),
  });

  try {
    assert.deepEqual(
      lines.filter((l) => l.includes("not running in a container")),
      [],
    );
  } finally {
    await sup.stop();
  }
});

/**
 * 🛑 THE INSTALL CONTAINER IS A SECOND CONSUMER, AND IT IS NOT THE SPAWN SEAM.
 * `installDeps` is handed an object built beside the spawn rather than through
 * the `spawnFn` wrapper, so an override that reached every spawn still left
 * the install container on the default image — and the agent reads the
 * `node_modules` volume that container writes.
 */
test("the handle's resolved override reaches the INSTALL call as well as the spawn", async () => {
  const seen: SpawnOptions[] = [];
  const installed: SpawnOptions[] = [];
  const handle = `ovr-${process.pid}-install`;
  writeOverride(handle, { image: "ghcr.io/example/chat-mcp-chromium:1" });

  // Container mode refuses to start without a token and without a confirmed
  // plan. Neither precondition is what this test is about.
  setToken("sk-ant-oat-x");
  markConfirmed(handle);

  const db = new DatabaseSync(":memory:");
  migrate(db);

  const sup = await startSupervisor(
    supervisorOptions({
      handle,
      db,
      extraDirs: DIRS,
      spawnChild: recordingChild(seen),
      installDeps: (o: SpawnOptions) => {
        installed.push(o);
      },
      log: () => undefined,
      container: true,
    }),
  );

  try {
    assert.equal(
      installed.length,
      1,
      `the install was not called exactly once: ${installed.length}`,
    );
    assert.deepEqual(installed[0]?.containerOverride, {
      image: "ghcr.io/example/chat-mcp-chromium:1",
    } satisfies ContainerOverride);
  } finally {
    await sup.stop();
  }
});

/**
 * The paired control. An `installDeps` object built by SPREADING a resolved
 * override in unconditionally would hand `containerOverride: undefined` to a
 * handle that configured nothing, which reads the same as the key being
 * absent — so the positive test alone cannot tell a wired call from a lucky
 * one.
 */
test("a handle with NO override file hands the install call no override", async () => {
  const seen: SpawnOptions[] = [];
  const installed: SpawnOptions[] = [];
  const handle = `ovr-${process.pid}-install-clean`;

  setToken("sk-ant-oat-x");
  markConfirmed(handle);

  const db = new DatabaseSync(":memory:");
  migrate(db);

  const sup = await startSupervisor(
    supervisorOptions({
      handle,
      db,
      extraDirs: DIRS,
      spawnChild: recordingChild(seen),
      installDeps: (o: SpawnOptions) => {
        installed.push(o);
      },
      log: () => undefined,
      container: true,
    }),
  );

  try {
    assert.equal(installed.length, 1);
    assert.equal(installed[0]?.containerOverride, null);
  } finally {
    await sup.stop();
  }
});
