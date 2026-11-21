import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 🛑 BEFORE the container import, which resolves a state path at module load.
process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), "cm-skip-"));

const { prepareAgentImage, IMAGE_TAG } =
  await import("../../src/supervise/container.js");

const OVERRIDE_IMAGE = "someone-elses/agent:latest";

/**
 * Records the SEQUENCE, because the compile's position is a separate contract
 * that `build-before-freshness.test.ts` owns and this file must not break.
 */
function recorder(stale: boolean) {
  const order: string[] = [];
  const args: string[][] = [];
  const lines: string[] = [];

  return {
    order,
    args,
    lines,
    compile: () => order.push("compile"),
    needsBuild: () => {
      order.push("needsBuild");
      return stale;
    },
    run: (_cmd: string, a: readonly string[]) => {
      order.push(`run:${a[0]}`);
      args.push([...a]);
      return Buffer.from("");
    },
    logLine: (line: string) => lines.push(line),
  };
}

/**
 * 🛑 THE DEFECT: AN OVERRIDE IMAGE PAID FOR A BUILD IT COULD NOT USE.
 *
 * `prepareAgentImage` only ever builds `IMAGE_TAG`, and
 * `runDependencyInstall` inspects `effectiveImage` — the override's. So a
 * handle with an `image` override waited out a full docker build of
 * `chat-mcp-agent:local` and was THEN refused for not having its own image.
 *
 * ⚠️ REFUSING IS CORRECT and is lee's ruling of 2026-11-15. The defect is
 * paying minutes of docker before the refusal, not the refusal.
 */
test("🔴 an override image skips the docker build entirely", () => {
  const r = recorder(true);

  prepareAgentImage(r.compile, {
    image: OVERRIDE_IMAGE,
    run: r.run,
    needsBuild: r.needsBuild,
    logLine: r.logLine,
  });

  assert.deepEqual(
    r.args.filter((a) => a[0] === "build"),
    [],
    `a docker build ran for ${IMAGE_TAG}, which this handle will never run`,
  );
});

/**
 * 🛑 THE FRESHNESS CHECK MUST NOT RUN EITHER. `imageNeedsBuild` inspects
 * `IMAGE_TAG` and hashes this project's sources, so consulting it for a
 * handle on another image is a verdict about the wrong thing — and it is the
 * call that decides whether the minutes get spent.
 */
test("🔴 an override image does not even consult the freshness check", () => {
  const r = recorder(true);

  prepareAgentImage(r.compile, {
    image: OVERRIDE_IMAGE,
    run: r.run,
    needsBuild: r.needsBuild,
    logLine: r.logLine,
  });

  assert.ok(
    !r.order.includes("needsBuild"),
    "the freshness of an image this handle will not run was computed anyway",
  );
});

/**
 * 🛑 THE COMPILE STILL RUNS, AND IT IS NOT OPTIONAL. lee ruled option B on
 * 2026-11-16: the compile is unconditional. A handle on an override image
 * still mounts and runs THIS project's `dist`, so skipping it would start the
 * agent on the last-compiled bundle.
 */
test("🛑 an override image still gets the unconditional compile, first", () => {
  const r = recorder(true);

  prepareAgentImage(r.compile, {
    image: OVERRIDE_IMAGE,
    run: r.run,
    needsBuild: r.needsBuild,
    logLine: r.logLine,
  });

  assert.equal(
    r.order[0],
    "compile",
    "the compile did not run first, so an override handle runs a stale dist",
  );
});

/** The operator has to be able to act on it, so the line names the image. */
test("the skip is reported, naming the image that caused it", () => {
  const r = recorder(true);

  prepareAgentImage(r.compile, {
    image: OVERRIDE_IMAGE,
    run: r.run,
    needsBuild: r.needsBuild,
    logLine: r.logLine,
  });

  assert.ok(
    r.lines.some((l) => l.includes(OVERRIDE_IMAGE)),
    `no logged line named ${OVERRIDE_IMAGE}, so the skip is silent`,
  );
});

/**
 * 🛑 THE PAIRED CONTROL. A `prepareAgentImage` that simply stopped building
 * would pass all four tests above and break every handle that works today.
 */
test("🛑 control — the project's own image is STILL built when stale", () => {
  const r = recorder(true);

  prepareAgentImage(r.compile, {
    image: IMAGE_TAG,
    run: r.run,
    needsBuild: r.needsBuild,
    logLine: r.logLine,
  });

  assert.ok(
    r.args.some((a) => a[0] === "build"),
    "a stale project image was not rebuilt, so the skip is unconditional",
  );
});

/**
 * The second control. `image` is optional, and every existing caller omits it
 * — so the default must be the project's tag, not the skip.
 */
test("🛑 control — omitting `image` builds, so the default is not the skip", () => {
  const r = recorder(true);

  prepareAgentImage(r.compile, {
    run: r.run,
    needsBuild: r.needsBuild,
    logLine: r.logLine,
  });

  assert.ok(
    r.args.some((a) => a[0] === "build"),
    "omitting `image` skipped the build, so every existing caller stopped building",
  );
});
