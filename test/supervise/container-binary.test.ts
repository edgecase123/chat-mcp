import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  dockerfileText,
  stageDirectives,
} from "../support/dockerfile-stages.js";

// 🛑 BEFORE any import that resolves a state path.
process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), "cm-container-binary-"));

const { setVendorToken } = await import("../../src/supervise/auth.js");
const { dockerRunPlan } =
  await import("../../src/supervise/drivers/containerized.js");
const { buildConfirmPlan } = await import("../../src/supervise/confirmPlan.js");
const { cursorSpawn } = await import("../../src/adapters/cursor-spawn.js");
const { claudeSpawn } = await import("../../src/adapters/claude-spawn.js");
const { CURSOR_CONTAINER_BINARY, CURSOR_HOST_BINARY } =
  await import("../../src/supervise/drivers/cursor.js");

/**
 * One filesystem per sandbox mode, and `VendorSpawn` used to carry one path
 * for both.
 *
 * 🛑 CURSOR IS THE ONLY FIXTURE THAT CAN FAIL THESE. `claudeSpawn.binary` and
 * `claudeSpawn.containerBinary` are both `"claude"`, so a Claude-shaped test
 * passes whichever field the spawner reads. Every assertion below therefore
 * drives `cursorSpawn`, whose host path is under `homedir()` and whose
 * container path is not.
 */

const PROJECT_DIR = mkdtempSync(join(tmpdir(), "cm-container-binary-project-"));

setVendorToken(cursorSpawn, "cursor-key-for-the-argv-assertions");

/** The argv a containerized Cursor spawn would exec. */
function cursorDockerArgs(): string[] {
  return dockerRunPlan(cursorSpawn, {
    cwd: PROJECT_DIR,
    supervisorHandle: "cursor1",
  }).args;
}

test("🛑 a containerized spawn execs the CONTAINER binary, never the host one", () => {
  const args = cursorDockerArgs();

  assert.ok(
    args.includes(CURSOR_CONTAINER_BINARY),
    `the container argv must name ${CURSOR_CONTAINER_BINARY}; got ${args.join(" ")}`,
  );

  // The failure this pins is exit 127 inside the container, which reads as a
  // dead agent rather than a missing CLI. A containerized Cursor agent had
  // never started.
  assert.ok(
    !args.includes(CURSOR_HOST_BINARY),
    "a host path under homedir() does not exist in a Linux container",
  );
});

test("🛑 every vendor declares a container binary, and Claude's is unchanged", () => {
  assert.equal(claudeSpawn.containerBinary, "claude");
  assert.equal(
    claudeSpawn.containerBinary,
    claudeSpawn.binary,
    "claude is on PATH in both filesystems; this records that, it does not derive it",
  );
});

test("🛑 cursor's container binary is NOT the host path, and NOT under homedir()", () => {
  assert.equal(cursorSpawn.containerBinary, CURSOR_CONTAINER_BINARY);

  assert.notEqual(
    cursorSpawn.containerBinary,
    cursorSpawn.binary,
    "one value for both modes is the defect; equality here means the field is decorative",
  );

  assert.ok(
    !CURSOR_CONTAINER_BINARY.startsWith(`${homedir()}/`),
    "the host home does not exist in the image, so a path under it exits 127",
  );
});

/**
 * 🛑 THE PREVIOUS GUARD COMPARED TWO CONSTANTS TO EACH OTHER.
 *
 * `cursor-vendor.test.ts` asserted
 * `CURSOR_CONTAINER_BINARY.startsWith(CURSOR_CONTAINER_HOME)`, which held
 * while the constant said `/root/.local/bin/cursor-agent` — a directory the
 * image does not contain. Both values were wrong together, so 2352 tests
 * passed over a path to nothing.
 *
 * This asserts against the DOCKERFILE instead, which is what actually puts the
 * binary somewhere.
 */
test("🛑 cursor's container binary is where the image INSTALLS cursor-agent", () => {
  const directives = stageDirectives(dockerfileText(), "cursor").join("\n");

  const symlinks = [
    ...directives.matchAll(/ln\s+-s\s+(\S+)\s+(\S+cursor-agent)\b/g),
  ].map((m) => m[2]!);

  assert.ok(
    symlinks.length > 0,
    "found no `ln -s … cursor-agent` in the cli-cursor lineage, so this guard proves nothing",
  );

  assert.ok(
    symlinks.includes(CURSOR_CONTAINER_BINARY),
    `the image installs cursor-agent at ${symlinks.join(", ")}, not at ${CURSOR_CONTAINER_BINARY}`,
  );
});

/**
 * 🛑 THE CLI PATH IS A SECOND REACH AT THE SAME EXEC, AND IT HAD ITS OWN 127.
 *
 * `--binary` carried a static default of `"claude"`, and `supervise`'s action
 * always forwarded `o.binary`. So `opts.binary ?? vendor.containerBinary`
 * never reached the vendor value from the command line: a
 * `--driver docker-cursor` spawn exec'd `claude` inside the Cursor image.
 * Raised by claude1 on this PR's plan review.
 *
 * ⚠️ ASSERTED ON THE SERVED HELP, NOT ON THE SOURCE TEXT. A source pin greens
 * on a default that moved into a variable, and commander prints the effective
 * default here.
 *
 * 🛑 THE WHOLE ENTRY, NEVER ONE LINE. Commander wraps the description column at
 * 80 with no TTY, and `--driver` already wraps onto a second line in this same
 * output. A one-line read of a wrapped entry cannot see a `(default:` that
 * landed below the fold, so it would green on the defect once the description
 * grew. claude1 measured the margin at 6 characters on PR 364.
 */

/** One option's full help entry, continuation lines included. */
function helpEntryFor(help: string, term: string): string {
  const lines = help.split("\n");
  const start = lines.findIndex((l) => l.includes(term));

  if (start === -1) return "";

  const entry = [lines[start]!];

  // A continuation is indented past the option column; the next OPTION starts
  // with its own dashes. `--help` itself is always last, so this terminates.
  for (const line of lines.slice(start + 1)) {
    if (/^\s*-/.test(line) || line.trim() === "") break;
    entry.push(line);
  }

  return entry.join("\n");
}

test("🛑 --binary has NO static default, so the vendor's value is reachable", () => {
  const help = execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      new URL("../../src/index.ts", import.meta.url).pathname,
      "supervise",
      "--help",
    ],
    { encoding: "utf8" },
  );

  const entry = helpEntryFor(help, "--binary <path>");

  assert.ok(entry, "`supervise --help` no longer documents --binary at all");
  assert.ok(
    !/\(default:/.test(entry),
    `a default here shadows every vendor's container binary; got: ${entry.trim()}`,
  );
});

/**
 * 🛑 THE CONTROL FOR THE GUARD ABOVE, BECAUSE A WRAPPED ENTRY IS THE FAILURE
 * MODE IT WAS JUST FIXED FOR. `--driver` wraps today and its `(default:` sits
 * on the SECOND line, so `helpEntryFor` finding it proves the reader follows a
 * wrap. A one-line read returns the first line alone and this goes red.
 */
test("⚠️ control — the entry reader follows a WRAPPED option's second line", () => {
  const help = execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      new URL("../../src/index.ts", import.meta.url).pathname,
      "supervise",
      "--help",
    ],
    { encoding: "utf8" },
  );

  const entry = helpEntryFor(help, "--driver <name>");

  assert.ok(
    entry.includes("\n"),
    "--driver no longer wraps, so this control no longer exercises a wrap",
  );
  assert.match(
    entry,
    /\(default:/,
    "the wrapped half of --driver's description was not read",
  );
});

/**
 * 🛑 THE BANNER IS WHAT THE OPERATOR APPROVES, so it naming a different file
 * from the one that execs is the misleading-operator class this project keeps
 * paying for. `buildConfirmPlan` is container-only — both callers gate on the
 * docker mode — so it needs no mode argument to get this right.
 */
test("🛑 the container confirm banner names the CONTAINER binary", () => {
  const plan = buildConfirmPlan(cursorSpawn, "cursor1");

  assert.equal(plan.binary, CURSOR_CONTAINER_BINARY);
  assert.notEqual(
    plan.binary,
    CURSOR_HOST_BINARY,
    "approving a host path for a container spawn describes a file that is not there",
  );
});
