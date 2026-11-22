import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildGrant } from "../../../src/supervise/grant.js";
import {
  deliverHostGrantFile,
  hostGrantConfigPathFor,
} from "../../../src/supervise/drivers/host-grant.js";
import { spawnFor, vendorsWithSpawn } from "../../../src/adapters/index.js";

/**
 * 🛑 THE ASSERTION IS THAT THE FILE LANDS, NOT THAT A FIELD IS SET.
 *
 * `assertHostGrantReachesBus` admits `"file"` by NOT being `"none"`, so a
 * vendor could declare the value and ship no writer at all — the refusal would
 * simply stop firing and the agent would go back to answering nothing. That is
 * the SAME silence #348 exists to end, reintroduced by the fix for it.
 * claude1's 🔵 on PR 387.
 */

/**
 * 🛑 `configPath` POINTS INSIDE THE TEMP CWD, NOT AT A FIXED `/tmp` NAME.
 * A mutant that made the writer land `grant.configPath` left a real file at a
 * shared path, and the NEXT run then failed on it — so a passing suite
 * depended on run order and the failure read as a code defect. Measured: the
 * state-dir control reddened on a clean tree only.
 */
function grantIn(cwd: string): ChildGrant {
  return {
    handle: "h-child",
    configPath: join(cwd, "state-dir-path-cursor-never-reads.json"),
    allowed: [],
    available: [],
    extraDirs: [],
  };
}

function withTempCwd<T>(fn: (cwd: string) => T): T {
  const cwd = mkdtempSync(join(tmpdir(), "chat-mcp-host-grant-"));

  try {
    return fn(cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

test("🔴 the config FILE lands in the agent's own cwd", () => {
  withTempCwd((cwd) => {
    const path = deliverHostGrantFile(spawnFor("cursor"), grantIn(cwd), cwd);

    assert.equal(path, join(cwd, ".cursor", "mcp.json"));
    assert.ok(existsSync(path), "the writer returned a path it did not write");
  });
});

/**
 * 🛑 THE STATE-DIR PATH IS THE DEFECT, SO IT IS ASSERTED AGAINST BY NAME.
 * `mcpConfigFor`'s host arm used to return `grant.configPath`, a location
 * `cursor-agent` never reads and no flag can name. A writer that landed the
 * file there would pass an existsSync-only test while changing nothing.
 */
test("🛑 the file is NOT written to the state-dir path cursor never reads", () => {
  withTempCwd((cwd) => {
    const path = deliverHostGrantFile(spawnFor("cursor"), grantIn(cwd), cwd);

    assert.notEqual(path, grantIn(cwd).configPath);
    assert.ok(
      !existsSync(grantIn(cwd).configPath),
      "the writer wrote the state-dir path, which is the bug this slice fixes",
    );
  });
});

test("the written config names the child's OWN handle, not the supervisor's", () => {
  withTempCwd((cwd) => {
    const written = JSON.parse(
      readFileSync(
        deliverHostGrantFile(spawnFor("cursor"), grantIn(cwd), cwd),
        "utf8",
      ),
    ) as { mcpServers: { chat: { args: string[] } } };

    const args = written.mcpServers.chat.args;

    assert.ok(args.includes("--handle"), "the server names no handle at all");
    assert.equal(args[args.indexOf("--handle") + 1], grantIn(cwd).handle);
  });
});

/**
 * 🛑 lee's SECURITY BOUND, 2026-11-21: *"as long as it cannot be used to run
 * unauthorized paths or bypass gates and gaurds"*.
 *
 * `.cursor/mcp.json` names an executable and its arguments, so the file IS an
 * execution surface. These two assertions are the bound expressed as a test
 * rather than a comment: the command is this build's own node, and the script
 * it runs is this build's own entry point.
 */
test("🛑 SECURITY — the server command is this build's own interpreter", () => {
  withTempCwd((cwd) => {
    const written = JSON.parse(
      readFileSync(
        deliverHostGrantFile(spawnFor("cursor"), grantIn(cwd), cwd),
        "utf8",
      ),
    ) as { mcpServers: { chat: { command: string; args: string[] } } };

    assert.equal(written.mcpServers.chat.command, process.execPath);
  });
});

test("🛑 SECURITY — the file declares exactly ONE server, named chat", () => {
  withTempCwd((cwd) => {
    const written = JSON.parse(
      readFileSync(
        deliverHostGrantFile(spawnFor("cursor"), grantIn(cwd), cwd),
        "utf8",
      ),
    ) as { mcpServers: Record<string, unknown> };

    assert.deepEqual(Object.keys(written.mcpServers), ["chat"]);
  });
});

/**
 * 🛑 lee's OWN PICK, 2026-11-21: refuse rather than overwrite. The operator's
 * `.cursor/mcp.json` is their configuration, and this project may destroy it
 * exactly never.
 */
test("🔴 an EXISTING .cursor/mcp.json is REFUSED, not overwritten", () => {
  withTempCwd((cwd) => {
    const path = join(cwd, ".cursor", "mcp.json");
    mkdirSync(join(cwd, ".cursor"), { recursive: true });
    writeFileSync(path, '{"mcpServers":{"the-operators-own":{}}}\n');

    assert.throws(
      () => deliverHostGrantFile(spawnFor("cursor"), grantIn(cwd), cwd),
      /refusing to overwrite/i,
    );

    assert.match(
      readFileSync(path, "utf8"),
      /the-operators-own/,
      "the refusal fired and the file was clobbered anyway",
    );
  });
});

test("the refusal names the FILE and says the supervisor did not create it", () => {
  withTempCwd((cwd) => {
    mkdirSync(join(cwd, ".cursor"), { recursive: true });
    writeFileSync(join(cwd, ".cursor", "mcp.json"), "{}\n");

    assert.throws(
      () => deliverHostGrantFile(spawnFor("cursor"), grantIn(cwd), cwd),
      (e) => {
        const message = (e as Error).message;

        assert.match(message, /\.cursor\/mcp\.json/);
        assert.match(message, /did not create/i);

        return true;
      },
    );
  });
});

/**
 * 🛑 A VENDOR THAT DOES NOT DELIVER BY FILE MUST NOT BE WRITTEN FOR.
 * Claude delivers by flags, so writing a project-local config for it would
 * plant a file in the operator's tree that nothing reads.
 */
test("🔴 control — a vendor delivering by FLAGS is refused by the writer", () => {
  withTempCwd((cwd) => {
    // 🛑 THE MESSAGE UNIQUE TO *THIS* GUARD, NOT A SHARED SUBSTRING. A first
    // cut matched `/hostGrantDelivery/`, which the missing-resolver guard also
    // contains — so disabling this check kept the test GREEN. Measured: that
    // mutant killed 0 of 20.
    assert.throws(
      () => deliverHostGrantFile(spawnFor("claude"), grantIn(cwd), cwd),
      /must not be called for it/,
    );
    assert.ok(
      !existsSync(join(cwd, ".cursor")),
      "the writer created a directory for a vendor it then refused",
    );
  });
});

/**
 * 🛑 THE DENOMINATOR. Every assertion above names `"cursor"` explicitly, so
 * renaming the value or the vendor would skip them all silently rather than
 * fail. This pins that at least one real vendor declares `"file"` AND that
 * every vendor which does has a writable path.
 */
test("🛑 every vendor declaring FILE resolves a path, and at least one does", () => {
  let checked = 0;

  for (const name of vendorsWithSpawn()) {
    const spawn = spawnFor(name);

    if (spawn.hostGrantDelivery !== "file") continue;

    checked += 1;
    assert.equal(
      typeof hostGrantConfigPathFor(spawn, "/somewhere"),
      "string",
      `vendor "${name}" declares hostGrantDelivery "file" and resolves no path`,
    );
  }

  assert.ok(checked > 0, 'no vendor declares hostGrantDelivery "file"');
});

/**
 * 🛑 THE GUARD THAT CLOSES claude1's 🔵. A vendor declaring `"file"` without
 * the field that says WHERE is the forgot-the-writer case, and it must fail at
 * the spawn rather than produce a quiet non-delivery.
 */
test("🔴 a vendor declaring FILE with no path resolver THROWS", () => {
  assert.throws(
    () =>
      hostGrantConfigPathFor(
        { vendor: "says-file-provides-nothing", hostGrantDelivery: "file" },
        "/somewhere",
      ),
    /says-file-provides-nothing/,
  );
});
