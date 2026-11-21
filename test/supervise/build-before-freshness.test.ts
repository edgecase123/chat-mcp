import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 🛑 BEFORE the container import, which resolves a state path at module load.
process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), "cm-prep-"));

const { prepareAgentImage } = await import("../../src/supervise/container.js");

/**
 * 🛑 THE COMPILE USED TO SIT INSIDE `if (imageNeedsBuild())`, AND THE HASH IT
 * CONSULTS COVERS `dist` — BUILD OUTPUT.
 *
 * So editing `src/` moved nothing the check could see. The branch did not run,
 * `npm run build` did not run, and the container started on the last-compiled
 * `dist` while the one instrument an operator would consult reported the image
 * as current. #262.
 *
 * ⚠️ THE ORDER IS THE PROPERTY, NOT THE DEDENT. A compile below the check —
 * even outside the branch — still hashes the stale `dist`, because the verdict
 * has already been computed. Every test here records the SEQUENCE, so a fix
 * that merely unindents fails.
 */

/** Records the order of the two steps, which is the whole contract. */
function recorder(freshness: boolean) {
  const order: string[] = [];
  const dockerArgs: readonly string[][] = [];
  const args: string[][] = dockerArgs as string[][];

  return {
    order,
    args,
    compile: () => order.push("compile"),
    needsBuild: () => {
      order.push("needsBuild");
      return !freshness;
    },
    run: (_cmd: string, a: readonly string[]) => {
      order.push(`run:${a[0]}`);
      args.push([...a]);
      return Buffer.from("");
    },
    logLine: () => undefined,
  };
}

test("🚨 the compile runs even when the image is already fresh", () => {
  const r = recorder(true);

  prepareAgentImage(r.compile, {
    run: r.run,
    needsBuild: r.needsBuild,
    logLine: r.logLine,
  });

  assert.ok(
    r.order.includes("compile"),
    "a fresh image skipped the compile, so the container runs the previous build",
  );
});

test("🚨 the compile runs BEFORE the freshness check is evaluated", () => {
  const r = recorder(true);

  prepareAgentImage(r.compile, {
    run: r.run,
    needsBuild: r.needsBuild,
    logLine: r.logLine,
  });

  assert.deepEqual(
    r.order,
    ["compile", "needsBuild"],
    "the freshness verdict was computed before the compile, so it hashed the stale dist",
  );
});

/**
 * POSITIVE CONTROL for the whole mechanism. Without it a `prepareAgentImage`
 * that only ever compiled would satisfy both tests above.
 */
test("a stale image still gets its docker build, after the compile", () => {
  const r = recorder(false);

  prepareAgentImage(r.compile, {
    run: r.run,
    needsBuild: r.needsBuild,
    logLine: r.logLine,
  });

  assert.deepEqual(r.order.slice(0, 2), ["compile", "needsBuild"]);
  assert.ok(
    r.args.some((a) => a[0] === "build"),
    "a stale image was never rebuilt",
  );
});

/**
 * 🛑 THE CONTROL THAT PROTECTS THE RULING'S COST CLAIM. Option B was chosen on
 * the basis that an unconditional compile does NOT mean an unconditional
 * docker build. If this ever fails, every containerized start pays minutes.
 */
test("🚨 a fresh image still skips the docker build, so the compile is the only added cost", () => {
  const r = recorder(true);

  prepareAgentImage(r.compile, {
    run: r.run,
    needsBuild: r.needsBuild,
    logLine: r.logLine,
  });

  assert.deepEqual(
    r.args.filter((a) => a[0] === "build"),
    [],
    "a fresh image was rebuilt anyway, so every start now pays for a docker build",
  );
});

/**
 * ⚠️ THE DENOMINATOR. Both recorders above are only meaningful if the fake
 * `needsBuild` is the one `prepareAgentImage` consulted — a signature change
 * that silently fell back to the real `imageNeedsBuild` would make the fresh
 * cases depend on the operator's own docker daemon.
 */
test("🚨 the injected freshness check is the one that is consulted", () => {
  const fresh = recorder(true);
  const stale = recorder(false);

  prepareAgentImage(fresh.compile, {
    run: fresh.run,
    needsBuild: fresh.needsBuild,
    logLine: fresh.logLine,
  });
  prepareAgentImage(stale.compile, {
    run: stale.run,
    needsBuild: stale.needsBuild,
    logLine: stale.logLine,
  });

  assert.ok(fresh.order.includes("needsBuild"), "the fake was never called");
  assert.notDeepEqual(
    fresh.args.map((a) => a[0]),
    stale.args.map((a) => a[0]),
    "the two verdicts produced the same docker calls, so the fake is not what decides",
  );
});

/**
 * 🛑 THE CLAIM THIS PINS: EXACTLY WHICH VENDORS NAME AN IMAGE NOTHING BUILDS.
 *
 * `buildImage` produces one tag, `IMAGE_TAG`. A vendor naming anything else
 * reaches `runDependencyInstall` with nothing built and is refused there,
 * which is lee's ruling of 2026-11-15 and not a defect.
 *
 * 🛑 THIS USED TO READ "the only vendor" AND ASSERT ABOUT `claudeSpawn` ALONE.
 * `cursorSpawn` then landed with an image that is NOT the built tag, and this
 * test stayed green — it was scoped to a vendor NAME rather than to the
 * property, so the condition its own docblock said should fail it arrived
 * invisibly. Enumerated instead, a third vendor forces the decision on the day
 * it is added.
 *
 * ⚠️ A FAILURE HERE IS A QUESTION, NOT A BUG. Add the vendor to the expected
 * list once you have confirmed the refusal is what you want for it.
 */
test("🚨 exactly the vendors listed here name an image the build never produces", async () => {
  const { IMAGE_TAG } = await import("../../src/supervise/container.js");
  const { vendorsWithSpawn, spawnFor } =
    await import("../../src/adapters/index.js");

  const unbuilt = [...vendorsWithSpawn()]
    .map((name) => spawnFor(name))
    .filter((spawn) => spawn.image !== IMAGE_TAG)
    .map((spawn) => spawn.vendor)
    .sort();

  assert.deepEqual(
    unbuilt,
    ["cursor"],
    "a vendor names an image prepareAgentImage never builds, so a containerized start is refused at the install step",
  );
});

/**
 * 🛑 THE SKIP IS WIRED ON THE SAME VALUE THE INSPECT USES. `prepareAgentImage`
 * now takes the effective image and declines to build `IMAGE_TAG` for a handle
 * that will not run it. Pinned here rather than only in
 * `override-image-skips-build.test.ts` because this file owns the build's
 * contract, and a reader of the enumeration above needs to find it.
 */
test("a vendor image that is not the built tag does not trigger a build", () => {
  const r = recorder(false);

  prepareAgentImage(r.compile, {
    image: "chat-mcp-cursor-agent:local",
    run: r.run,
    needsBuild: r.needsBuild,
    logLine: r.logLine,
  });

  assert.deepEqual(
    r.args.filter((a) => a[0] === "build"),
    [],
    "an unbuildable vendor image still paid for a build of the project tag",
  );
});
