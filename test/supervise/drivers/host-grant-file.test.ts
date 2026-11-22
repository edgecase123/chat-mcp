import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

/**
 * 🛑 THE MESSAGE NAMES THE FILE AND THE HANDLE, AND ASSERTS NO AUTHOR. It used
 * to say "the supervisor did not create it", which is false whenever an older
 * build of this project wrote it — and was false on every restart before
 * re-delivery became a no-op.
 */
test("the refusal names the FILE and the HANDLE, and tells the operator what to do", () => {
  withTempCwd((cwd) => {
    mkdirSync(join(cwd, ".cursor"), { recursive: true });
    writeFileSync(join(cwd, ".cursor", "mcp.json"), "{}\n");

    assert.throws(
      () => deliverHostGrantFile(spawnFor("cursor"), grantIn(cwd), cwd),
      (e) => {
        const message = (e as Error).message;

        assert.match(message, /\.cursor\/mcp\.json/);
        assert.match(message, /h-child/);
        assert.match(message, /move it aside|delete it/i);
        assert.doesNotMatch(message, /did not create/i);

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

/**
 * 🛑 `wx` GUARDS THE FILE AND NOT THE DIRECTORY ABOVE IT, AND THAT GAP IS REAL.
 *
 * `O_CREAT|O_EXCL` refuses to follow a symlink planted AT `mcp.json`. It does
 * nothing about `.cursor` itself being a symlink: `mkdirSync({recursive:true})`
 * sees the resolved directory already exists and no-ops, then `wx` succeeds,
 * and the config lands in the symlink's TARGET.
 *
 * Measured before the fix: a `.cursor -> /tmp/elsewhere` symlink put the file
 * at `/tmp/elsewhere/mcp.json`. A supervised project that ships such a symlink
 * is the delivery vector, and `.gitignore` in THIS repo protects no other one.
 *
 * ⚠️ THE CONTENT IS PINNED, SO THIS IS NOT AN ARBITRARY-EXECUTION HOLE. It is
 * a write outside the directory the operator named, which the writer's own
 * docblock promises never happens.
 */
test("🔴 a SYMLINKED .cursor directory is refused, not followed", () => {
  withTempCwd((cwd) => {
    const elsewhere = mkdtempSync(join(tmpdir(), "chat-mcp-elsewhere-"));

    try {
      symlinkSync(elsewhere, join(cwd, ".cursor"));

      assert.throws(
        () => deliverHostGrantFile(spawnFor("cursor"), grantIn(cwd), cwd),
        /symlink|outside/i,
      );

      assert.ok(
        !existsSync(join(elsewhere, "mcp.json")),
        "the writer followed the symlink and wrote outside the project directory",
      );
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

/**
 * 🛑 THE CWD ITSELF MAY BE A SYMLINK, AND THAT IS LEGITIMATE. macOS `/tmp` is
 * one. Refusing it would break every supervised project under a symlinked
 * path, so containment is judged on REAL paths rather than by banning them.
 */
test("🔴 control — a symlinked CWD is allowed, and the file lands inside it", () => {
  withTempCwd((real) => {
    const link = join(mkdtempSync(join(tmpdir(), "chat-mcp-link-")), "proj");

    try {
      symlinkSync(real, link);

      const path = deliverHostGrantFile(
        spawnFor("cursor"),
        grantIn(link),
        link,
      );

      assert.ok(existsSync(path));
      assert.equal(
        realpathSync(path),
        join(realpathSync(real), ".cursor", "mcp.json"),
      );
    } finally {
      rmSync(dirname(link), { recursive: true, force: true });
    }
  });
});

/**
 * 🛑 DISCRIMINATES THE `lstat` HALF OF THE GUARD FROM THE `realContains` HALF.
 * Dropping `realContains` killed none of the 22 tests, because every case
 * above has `.cursor` itself as the symlink — which `lstat` alone catches.
 *
 * A vendor may resolve a DEEPER path, and then an INTERMEDIATE component can
 * be the link while the final directory is a real one. `lstat` on the final
 * directory says nothing about it; only comparing real paths does.
 */
test("🔴 an intermediate symlinked component is refused, not just the last one", () => {
  withTempCwd((cwd) => {
    const elsewhere = mkdtempSync(join(tmpdir(), "chat-mcp-elsewhere-"));

    try {
      mkdirSync(join(elsewhere, "inner"), { recursive: true });
      symlinkSync(elsewhere, join(cwd, "link"));

      const nested = {
        vendor: "nests-its-config",
        hostGrantDelivery: "file" as const,
        hostGrantConfigPath: (dir: string) =>
          join(dir, "link", "inner", "mcp.json"),
      };

      assert.throws(
        () => deliverHostGrantFile(nested, grantIn(cwd), cwd),
        /symlink|outside/i,
      );

      assert.ok(
        !existsSync(join(elsewhere, "inner", "mcp.json")),
        "the writer escaped through an intermediate symlink",
      );
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

/**
 * 🛑 DISCRIMINATES THE `realContains` HALF FROM THE `lstat` HALF. Dropping
 * `lstat` also killed none of the 22, because `realContains` catches a link
 * that LEAVES the project.
 *
 * A `.cursor` symlink pointing back INSIDE the project satisfies
 * `realContains` and is still refused. A supervised project that can choose
 * where its own config file really lands is deciding something the supervisor
 * is supposed to decide, and "contained" is a weaker promise than "the path we
 * named".
 */
test("🔴 a .cursor symlink pointing INSIDE the project is still refused", () => {
  withTempCwd((cwd) => {
    mkdirSync(join(cwd, "decoy"), { recursive: true });
    symlinkSync(join(cwd, "decoy"), join(cwd, ".cursor"));

    assert.throws(
      () => deliverHostGrantFile(spawnFor("cursor"), grantIn(cwd), cwd),
      /symlink|outside/i,
    );

    assert.ok(
      !existsSync(join(cwd, "decoy", "mcp.json")),
      "a contained symlink was followed; containment is not the same as the named path",
    );
  });
});

/**
 * 🛑 0600, MATCHING THE STATE-DIR WRITER. This file holds no secret, so the
 * mode is consistency rather than confidentiality — but it lands in a project
 * directory that may not ignore it, and it names this host's absolute paths.
 */
test("🔴 the written file is 0600, not umask-default", () => {
  withTempCwd((cwd) => {
    const path = deliverHostGrantFile(spawnFor("cursor"), grantIn(cwd), cwd);

    assert.equal(statSync(path).mode & 0o777, 0o600);
  });
});

/**
 * 🛑 THE HANDLE IS VALIDATED HERE, NOT BORROWED FROM A CALLER. It reaches the
 * written file's argv. It is already safe in production because `buildGrant`
 * validates every handle before a grant exists, but that is an indirect
 * coupling through a function this vendor does not otherwise need.
 */
test("🔴 a malformed handle is refused before anything is written", () => {
  withTempCwd((cwd) => {
    const bad = { ...grantIn(cwd), handle: "../../etc/passwd" };

    assert.throws(() => deliverHostGrantFile(spawnFor("cursor"), bad, cwd));

    assert.ok(
      !existsSync(join(cwd, ".cursor")),
      "a malformed handle got as far as creating the directory",
    );
  });
});

/**
 * 🛑 THE SECOND START MUST NOT HIT A REFUSAL THE SUPERVISOR ITSELF CAUSED.
 *
 * Nothing deletes this file, so a granted host Cursor handle started exactly
 * ONCE per project directory. The second start threw "the supervisor did not
 * create it" — about a file the supervisor had just created. An operator then
 * goes looking for a config of their own that is not there.
 *
 * ⚠️ IDENTICAL CONTENT IS A NO-OP, NOT AN OVERWRITE. The file we would write
 * is fully determined by the handle, so "is this already ours?" is answerable
 * exactly, and anything else keeps the refusal.
 */
test("🔴 starting TWICE in one project directory is a no-op, not a refusal", () => {
  withTempCwd((cwd) => {
    const first = deliverHostGrantFile(spawnFor("cursor"), grantIn(cwd), cwd);
    const before = readFileSync(first, "utf8");

    const second = deliverHostGrantFile(spawnFor("cursor"), grantIn(cwd), cwd);

    assert.equal(second, first);
    assert.equal(readFileSync(second, "utf8"), before);
  });
});

/**
 * 🛑 A DIFFERENT HANDLE IS STILL REFUSED, AND THE MESSAGE NO LONGER CLAIMS
 * AUTHORSHIP. An older chat-mcp may have written it, so "the supervisor did
 * not create it" was a guess stated as a fact.
 */
test("🔴 a file with DIFFERENT content is refused, and the message claims no author", () => {
  withTempCwd((cwd) => {
    deliverHostGrantFile(spawnFor("cursor"), grantIn(cwd), cwd);

    const other = { ...grantIn(cwd), handle: "someone-else" };

    assert.throws(
      () => deliverHostGrantFile(spawnFor("cursor"), other, cwd),
      (e) => {
        const message = (e as Error).message;

        assert.match(message, /refusing to overwrite/i);
        assert.doesNotMatch(message, /did not create/i);

        return true;
      },
    );
  });
});

/**
 * 🛑 THE DANGLING-LEAF ESCAPE. `assertDirIsNotASymlinkEscape` returned early
 * when the config directory did not exist, reasoning it was about to be made
 * inside the project. `mkdirSync({recursive:true})` then followed a symlinked
 * ANCESTOR and created it outside.
 *
 * ⚠️ THE EARLIER INTERMEDIATE-SYMLINK TEST CANNOT SEE THIS, because its
 * fixture creates the inner directory first, so the leaf always exists.
 * Measured: without the fix the file landed in the link's target and nothing
 * threw. claude1 on PR 389.
 */
test("🔴 a symlinked ancestor is refused even when the leaf directory is ABSENT", () => {
  withTempCwd((cwd) => {
    const elsewhere = mkdtempSync(join(tmpdir(), "chat-mcp-elsewhere-"));

    try {
      symlinkSync(elsewhere, join(cwd, "link"));

      const nested = {
        vendor: "nests-its-config",
        hostGrantDelivery: "file" as const,
        hostGrantConfigPath: (dir: string) =>
          join(dir, "link", "inner", "mcp.json"),
      };

      assert.throws(
        () => deliverHostGrantFile(nested, grantIn(cwd), cwd),
        /symlink|outside/i,
      );

      assert.ok(
        !existsSync(join(elsewhere, "inner")),
        "mkdirSync followed a symlinked ancestor and created a directory outside the project",
      );
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

/**
 * 🛑 CONTAINMENT IS JUDGED BEFORE ANY READ, NOT AFTER.
 *
 * Making re-delivery a no-op put an `existsSync`/`readFileSync` branch ABOVE
 * `assertDirIsNotASymlinkEscape`, so a `.cursor` symlinked OUT of the project
 * that happened to hold our exact bytes returned successfully — the escape the
 * guard exists to refuse, waved through by the fix for a different bug.
 *
 * ⚠️ THE FIX FOR ONE FINDING OPENED A HOLE IN THE FIX FOR THE OTHER. The
 * ordering is the whole contract: nothing about a path may be trusted, read or
 * reported until the path itself is known to be inside the project.
 * claude1 on PR 389, second review.
 */
test("🔴 a symlinked-OUT .cursor holding OUR OWN bytes is still refused", () => {
  withTempCwd((cwd) => {
    const elsewhere = mkdtempSync(join(tmpdir(), "chat-mcp-elsewhere-"));

    try {
      // The exact file this supervisor would write, planted outside.
      const staged = mkdtempSync(join(tmpdir(), "chat-mcp-staged-"));
      const ours = readFileSync(
        deliverHostGrantFile(spawnFor("cursor"), grantIn(staged), staged),
        "utf8",
      );
      writeFileSync(join(elsewhere, "mcp.json"), ours);
      rmSync(staged, { recursive: true, force: true });

      symlinkSync(elsewhere, join(cwd, ".cursor"));

      assert.throws(
        () => deliverHostGrantFile(spawnFor("cursor"), grantIn(cwd), cwd),
        /symlink|outside/i,
        "identical content waved the escape through",
      );
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});
