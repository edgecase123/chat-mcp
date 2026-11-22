import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 🛑 BEFORE the container import, which resolves a state path at module load.
process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), "cm-vimg-"));

const {
  prepareAgentImage,
  buildImage,
  imageNeedsBuild,
  IMAGE_TAG,
  CURSOR_IMAGE_TAG,
} = await import("../../src/supervise/container.js");

/**
 * #380 slice 4: a contained CURSOR agent could not start at all, because
 * nothing ever built its image.
 *
 * 🛑 THE SYMPTOM WAS A CONTAINER THAT CAME UP AND DIED. The image bakes
 * `dist/`, the Cursor image had been built by hand before the turn relay
 * existed, and `prepareAgentImage` returned early for every image that was not
 * `IMAGE_TAG`. So the container exec'd a module that was not in it:
 * `Cannot find module '/opt/chat-mcp/dist/relay/bin.js'`, exit 1, no prompt
 * ever sent — which reads as a dead agent rather than a missing build.
 *
 * ⚠️ AN OPERATOR OVERRIDE IMAGE MUST STILL BE SKIPPED, and that is lee's
 * ruling of 2026-11-15 kept intact by `override-image-skips-build.test.ts`.
 * The distinction is whether a VENDOR was named: this project can build a
 * vendor's image and cannot build a stranger's.
 */

const OVERRIDE_IMAGE = "someone-elses/agent:latest";

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

const buildArgs = (r: ReturnType<typeof recorder>) =>
  r.args.filter((a) => a[0] === "build");

test("🔴 a VENDOR's image is built, not skipped as if it were a stranger's", () => {
  const r = recorder(true);

  prepareAgentImage(r.compile, {
    image: CURSOR_IMAGE_TAG,
    buildVendor: "cursor",
    run: r.run,
    needsBuild: r.needsBuild,
    logLine: r.logLine,
  });

  assert.equal(
    buildArgs(r).length,
    1,
    `no docker build ran for ${CURSOR_IMAGE_TAG}, so a contained cursor agent starts on whatever was there`,
  );
});

test("🔴 the vendor build is TAGGED as the vendor's image, never the claude one", () => {
  const r = recorder(true);

  prepareAgentImage(r.compile, {
    image: CURSOR_IMAGE_TAG,
    buildVendor: "cursor",
    run: r.run,
    needsBuild: r.needsBuild,
    logLine: r.logLine,
  });

  const tag = buildArgs(r)[0]?.[buildArgs(r)[0]!.indexOf("-t") + 1];

  assert.equal(
    tag,
    CURSOR_IMAGE_TAG,
    `the build tagged "${tag}", so the vendor's image is still missing and the claude one was overwritten`,
  );
});

/**
 * 🛑 THE BUILD ARG IS THE WHOLE VENDOR SWITCH. Without it the Dockerfile's
 * `ARG AGENT_VENDOR=claude` default wins, so the command would tag a CLAUDE
 * image with the CURSOR name — an image that starts, finds no `cursor-agent`,
 * and exits 127.
 */
test("🔴 the vendor build passes --build-arg AGENT_VENDOR, or it bakes the wrong CLI", () => {
  const r = recorder(true);

  prepareAgentImage(r.compile, {
    image: CURSOR_IMAGE_TAG,
    buildVendor: "cursor",
    run: r.run,
    needsBuild: r.needsBuild,
    logLine: r.logLine,
  });

  assert.ok(
    buildArgs(r)[0]?.includes("AGENT_VENDOR=cursor"),
    `the build args were ${JSON.stringify(buildArgs(r)[0])}; the Dockerfile default would bake the claude CLI`,
  );
});

/**
 * 🛑 THE FRESHNESS KEY IS PER IMAGE. One `builtHash` for the whole file means
 * building either image marks BOTH current, so the second vendor's image is
 * never rebuilt again after the first one is — silently, and for good.
 */
test("🔴 building one vendor's image does NOT mark another's as fresh", () => {
  const present = () => Buffer.from("");

  // 🛑 START FROM NO RECORDED BUILD, OR THE TESTS ABOVE ANSWER THIS ONE. They
  // call the real `buildImage` through `prepareAgentImage`, so the cursor
  // image is already recorded in the shared state file by the time this runs —
  // and the assertion below would then pass or fail on test ORDER.
  rmSync(join(process.env.CHAT_MCP_HOME as string, "container.json"), {
    force: true,
  });

  buildImage(present, { image: IMAGE_TAG, vendor: "claude" });

  assert.equal(
    imageNeedsBuild(present, IMAGE_TAG),
    false,
    "the image just built still reads as stale, so every start rebuilds it",
  );
  assert.equal(
    imageNeedsBuild(present, CURSOR_IMAGE_TAG),
    true,
    "building the claude image marked the CURSOR image fresh, so it is never built",
  );
});

/**
 * 🛑 PAIRED CONTROL, AND IT IS THE RULING THIS CHANGE MUST NOT BREAK. A
 * `prepareAgentImage` that simply built everything would pass all four tests
 * above and charge an override handle minutes of docker for an image it is
 * then refused for.
 */
test("🛑 control — an image with NO vendor named is still skipped", () => {
  const r = recorder(true);

  prepareAgentImage(r.compile, {
    image: OVERRIDE_IMAGE,
    run: r.run,
    needsBuild: r.needsBuild,
    logLine: r.logLine,
  });

  assert.deepEqual(
    buildArgs(r),
    [],
    "a docker build ran for an image this project cannot build",
  );
  assert.ok(
    r.lines.some((l) => l.includes(OVERRIDE_IMAGE)),
    "the skip is silent, so the operator cannot act on it",
  );
});

/** The second control: every existing caller omits both fields. */
test("🛑 control — omitting image and vendor still builds the claude image", () => {
  const r = recorder(true);

  prepareAgentImage(r.compile, {
    run: r.run,
    needsBuild: r.needsBuild,
    logLine: r.logLine,
  });

  assert.equal(
    buildArgs(r).length,
    1,
    "omitting both fields stopped building, so every existing caller broke",
  );
});

/**
 * 🛑 THE LEGACY FOLD, WHICH IS LOAD-BEARING AND WAS PROTECTED BY NOTHING.
 *
 * `builtHash` was one string describing the claude image. Every install on
 * disk has one. Reading the new map without folding it in makes that image
 * read as never built, so the FIRST start after this change pays for a full
 * docker build it does not need — silently, and on every machine at once.
 *
 * ⚠️ RAISED BY claude2 reviewing PR 390: they measured that the fold WORKS and
 * said plainly that they could not show a test PROTECTS it. This is that test.
 */
test("🔴 a pre-existing single builtHash still counts as the claude image being built", () => {
  const present = () => Buffer.from("");
  const statePath = join(process.env.CHAT_MCP_HOME as string, "container.json");

  // Build once so the hash on disk is the CURRENT one, then rewrite the file
  // in the shape every existing install actually has.
  rmSync(statePath, { force: true });
  buildImage(present, { image: IMAGE_TAG, vendor: "claude" });

  const built = (
    JSON.parse(readFileSync(statePath, "utf8")) as {
      builtHashes: Record<string, string>;
    }
  ).builtHashes[IMAGE_TAG];

  assert.ok(built, "the build recorded no hash, so this test proves nothing");

  writeFileSync(
    statePath,
    `${JSON.stringify({ builtHash: built, confirmed: {} }, null, 2)}\n`,
  );

  assert.equal(
    imageNeedsBuild(present, IMAGE_TAG),
    false,
    "an existing install reads as never built, so it pays for a docker build it does not need",
  );
});

/**
 * 🛑 THE CONTROL THAT KEEPS THE FOLD HONEST. A fold that answered "fresh" for
 * every image would pass the test above and re-open the leak the per-image map
 * exists to close.
 */
test("🛑 control — the legacy hash is folded in for the CLAUDE image only", () => {
  const present = () => Buffer.from("");
  const statePath = join(process.env.CHAT_MCP_HOME as string, "container.json");

  rmSync(statePath, { force: true });
  buildImage(present, { image: IMAGE_TAG, vendor: "claude" });

  const built = (
    JSON.parse(readFileSync(statePath, "utf8")) as {
      builtHashes: Record<string, string>;
    }
  ).builtHashes[IMAGE_TAG];

  writeFileSync(
    statePath,
    `${JSON.stringify({ builtHash: built, confirmed: {} }, null, 2)}\n`,
  );

  assert.equal(
    imageNeedsBuild(present, CURSOR_IMAGE_TAG),
    true,
    "the legacy claude hash was folded in for the cursor image too, so it is never built",
  );
});
