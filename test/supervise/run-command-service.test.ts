import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 🛑 BEFORE any import that resolves a state path.
process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), "chat-mcp-rcs-"));

const { Refusal, listCommandsFor, runCommandFor } =
  await import("../../src/supervise/run-command-service.js");
const { dirsFor, registerProject } =
  await import("../../src/supervise/projects.js");
const { ensureManifestDir, manifestPathFor } =
  await import("../../src/util/paths.js");

/** A project directory with the scripts its manifest names. */
function project(
  commands: unknown,
  scripts: Readonly<Record<string, string>> = {},
): { dir: string; manifest: unknown } {
  const dir = mkdtempSync(join(tmpdir(), "chat-mcp-project-"));

  mkdirSync(join(dir, "scripts"), { recursive: true });

  for (const [name, body] of Object.entries(scripts)) {
    const path = join(dir, "scripts", name);
    writeFileSync(path, body);
    chmodSync(path, 0o755);
  }

  return { dir, manifest: { projectDir: dir, ...(commands as object) } };
}

function install(
  handle: string,
  built: { dir: string; manifest: unknown },
): string {
  installManifestOnly(handle, built);
  registerProject(handle, built.dir);

  return built.dir;
}

/** The manifest alone, so a test can point the REGISTRATION somewhere else. */
function installManifestOnly(
  handle: string,
  built: { dir: string; manifest: unknown },
): void {
  ensureManifestDir();
  writeFileSync(manifestPathFor(handle), JSON.stringify(built.manifest));
}

const GATE = {
  commands: [{ name: "run-gate", script: "scripts/gate.sh" }],
};

test("the service is reachable without a transport, and lists a handle's commands", () => {
  install("lister", project(GATE, { "gate.sh": "#!/bin/sh\necho hi\n" }));

  const { commands } = listCommandsFor("lister", { sandbox: "host" });

  assert.deepEqual(
    commands.map((c) => c.name),
    ["run-gate"],
  );
});

test("a listed command never carries its script path to the caller", () => {
  install("nopath", project(GATE, { "gate.sh": "#!/bin/sh\necho hi\n" }));

  const { commands } = listCommandsFor("nopath", { sandbox: "host" });

  assert.equal(JSON.stringify(commands).includes("gate.sh"), false);
});

test("a command runs in the directory the MANIFEST names", async () => {
  const dir = install(
    "runner",
    project(GATE, { "gate.sh": "#!/bin/sh\npwd\n" }),
  );

  const result = await runCommandFor(
    "runner",
    "run-gate",
    {},
    { sandbox: "host" },
  );

  assert.equal(result.exitCode, 0);
  // macOS /var is a symlink to /private/var, so compare the tail.
  assert.equal(
    result.stdout.trim().endsWith(dir.replace(/^\/private/, "")),
    true,
  );
});

test("a NON-ZERO exit is a RESULT, not a refusal", async () => {
  install(
    "failer",
    project(GATE, { "gate.sh": "#!/bin/sh\necho out\nexit 3\n" }),
  );

  const result = await runCommandFor(
    "failer",
    "run-gate",
    {},
    { sandbox: "host" },
  );

  assert.equal(result.exitCode, 3);
  assert.equal(result.stdout.trim(), "out");
});

test("a handle with no manifest is REFUSED, and the caller is told nothing about the host", async () => {
  await assert.rejects(
    () => runCommandFor("nomanifest", "run-gate", {}, { sandbox: "host" }),
    (err: unknown) => {
      assert.ok(err instanceof Refusal, "must be a Refusal");
      assert.equal(err.message, "this agent has no usable command manifest");

      return true;
    },
  );
});

test("a Refusal keeps the operator detail OFF the public message", async () => {
  await assert.rejects(
    () => runCommandFor("nomanifest2", "run-gate", {}, { sandbox: "host" }),
    (err: unknown) => {
      assert.ok(err instanceof Refusal);
      // The detail exists for the host log and is NOT the public sentence.
      assert.notEqual(err.detail, err.message);

      return true;
    },
  );
});

test("a command name absent from the manifest is refused however it is spelled", async () => {
  install("narrow", project(GATE, { "gate.sh": "#!/bin/sh\necho hi\n" }));

  await assert.rejects(
    () => runCommandFor("narrow", "run-deploy", {}, { sandbox: "host" }),
    (err: unknown) => err instanceof Refusal,
  );
});

/**
 * 🛑 THIS IS A PARSE-TIME REFUSAL, NOT A CONTAINMENT ONE, AND THE OLD NAME HID
 * THAT. A lexical `..` never reaches `checkedScriptPath`, because the manifest
 * reader rejects the manifest first — so the public sentence is the
 * no-manifest one. The containment wiring is covered by the symlink test below,
 * which is the only shape the parser cannot see.
 */
test("a manifest naming a traversal script is refused when it is PARSED", async () => {
  const built = project(
    { commands: [{ name: "escape", script: "../../etc/hosts" }] },
    { "gate.sh": "#!/bin/sh\necho hi\n" },
  );
  install("escapee", built);

  await assert.rejects(
    () => runCommandFor("escapee", "escape", {}, { sandbox: "host" }),
    (err: unknown) => {
      assert.ok(err instanceof Refusal);
      assert.equal(err.message, "this agent has no usable command manifest");
      // The reason is the PARSER's, and it stays in the host-side detail.
      assert.match(String(err.detail), /must stay inside the project/);

      return true;
    },
  );
});

/**
 * 🛑 THE UNIT TEST ON `checkedScriptPath` PROVES THE FUNCTION REFUSES. THIS
 * PROVES THE SERVICE CALLS IT. Deleting the call leaves `containment.test.ts`
 * green, and a symlink is the one escape the manifest parser cannot see.
 */
test("a script that SYMLINKS out of the project is refused", async () => {
  const built = project(GATE);
  install("linker", built);
  // `/bin/echo`, not `/bin/sh`: a mutant that DELETES the containment call must
  // run the target and exit, never sit on an interactive shell's stdin for the
  // 15-minute command timeout.
  symlinkSync("/bin/echo", join(built.dir, "scripts", "gate.sh"));

  await assert.rejects(
    () => runCommandFor("linker", "run-gate", {}, { sandbox: "host" }),
    (err: unknown) => {
      assert.ok(err instanceof Refusal);
      assert.match(err.message, /not inside the project directory/);

      return true;
    },
  );
});

/**
 * 🛑 NO HOST PATH CROSSES THE BOUNDARY. The caller writes the manifest, so a
 * refusal that names what a path resolved to is an arbitrary-path existence and
 * realpath oracle for the whole host.
 */
test("the CONTAINMENT refusal carries no host path", async () => {
  const built = project(GATE);
  install("linker2", built);
  symlinkSync("/bin/echo", join(built.dir, "scripts", "gate.sh"));

  await assert.rejects(
    () => runCommandFor("linker2", "run-gate", {}, { sandbox: "host" }),
    (err: unknown) => {
      assert.ok(err instanceof Refusal);
      // 🛑 THE BRANCH FIRST. Six public sentences out of this service are
      // slashless, so a refusal that lands EARLIER satisfies the no-path
      // assertion below while covering nothing.
      assert.match(err.message, /not inside the project directory/);
      assert.equal(
        err.message.includes("/"),
        false,
        `the refusal leaked a path: ${err.message}`,
      );

      return true;
    },
  );
});

/**
 * ⚠️ THE SIBLING ABOVE STOPS AT `checkedScriptPath`. This one reaches
 * `runScript`, where `execFile` puts the absolute path into `err.message` — a
 * different mechanism for the same property, so neither covers the other.
 */
test("a SPAWN FAILURE carries no host path", async () => {
  const built = project(GATE, { "gate.sh": "#!/bin/sh\necho hi\n" });
  install("unrunnable", built);

  // Not executable, so `execFile` fails with EACCES naming the full path.
  chmodSync(join(built.dir, "scripts", "gate.sh"), 0o644);

  await assert.rejects(
    () => runCommandFor("unrunnable", "run-gate", {}, { sandbox: "host" }),
    (err: unknown) => {
      assert.ok(err instanceof Refusal);
      // 🛑 THE BRANCH FIRST, for the same reason as the test above. `run-script`
      // builds this sentence from `err.code`, so the match proves the call
      // reached `execFile` rather than being refused on the way there.
      assert.match(err.message, /could not be started \(EACCES\)/);
      assert.equal(
        err.message.includes("/"),
        false,
        `the refusal leaked a path: ${err.message}`,
      );

      return true;
    },
  );
});

/**
 * 🛑 THE ONLY PLACE THE REGISTRATION IMMUNITY IS PINNED.
 *
 * This service is where a `run_command` call enters, and it is reachable with
 * no socket at all.
 *
 * 🛑 THE REGISTRATION HOLDS ONLY THE DECOY, NEVER BOTH. `registerProject`
 * APPENDS, so registering real-then-decoy leaves real at index 0 and any
 * implementation reading index 0 still passes. That shape is a decoy test.
 */
test("rewriting the registration does not move where a command runs", async () => {
  const real = project(GATE, { "gate.sh": "#!/bin/sh\necho real\n" });
  const decoy = project(GATE, { "gate.sh": "#!/bin/sh\necho decoy\n" });

  installManifestOnly("swapped", real);
  registerProject("swapped", decoy.dir);

  // POSITIVE CONTROL. Without it a `registerProject` that silently no-opped
  // would leave this test green while proving nothing.
  assert.deepEqual(dirsFor("swapped"), [decoy.dir]);

  const result = await runCommandFor(
    "swapped",
    "run-gate",
    {},
    { sandbox: "host" },
  );

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /real/);
  assert.doesNotMatch(result.stdout, /decoy/);
});

/**
 * 🛑 THE TRUST BOUNDARY, AT THE LAYER THE CALL NOW ENTERS.
 *
 * The script's CONTENT AT RUN TIME is what runs. A containerized agent holds
 * the project directory read-write, so that content is the agent's to choose.
 * No symlink and no race are required.
 *
 * `O_NOFOLLOW` would not close this: pinning the inode pins bytes the agent
 * already controls. The test exists so that a later validate-at-install step
 * cannot be mistaken for closing the hole.
 */
test("the script content present at RUN time runs, not what was installed", async () => {
  const dir = install(
    "runtime",
    project(GATE, { "gate.sh": "#!/bin/sh\necho first\n" }),
  );

  writeFileSync(join(dir, "scripts", "gate.sh"), "#!/bin/sh\necho second\n");
  chmodSync(join(dir, "scripts", "gate.sh"), 0o755);

  const result = await runCommandFor(
    "runtime",
    "run-gate",
    {},
    { sandbox: "host" },
  );

  assert.equal(result.stdout.trim(), "second");
});

/**
 * 🛑 THE MANIFEST ALONE IS SUFFICIENT. `projects.json` is consulted on neither
 * the present nor the absent path, so a handle nobody registered still runs its
 * own commands.
 */
test("a handle with a manifest but NO registration still runs its command", async () => {
  installManifestOnly(
    "unreg",
    project(GATE, { "gate.sh": "#!/bin/sh\necho no-registration\n" }),
  );

  // POSITIVE CONTROL. `dirsFor` throws on an unregistered handle, so without
  // this the test could not tell "never registered" from "registered somewhere".
  assert.throws(() => dirsFor("unreg"), /no project directory registered/);

  const result = await runCommandFor(
    "unreg",
    "run-gate",
    {},
    { sandbox: "host" },
  );

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /no-registration/);
});
