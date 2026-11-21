import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 🛑 BEFORE any import that resolves a state path.
process.env.CHAT_MCP_HOME = mkdtempSync(
  join(tmpdir(), "chat-mcp-confirm-plan-"),
);

const { overridePathFor, overridesDir } =
  await import("../../src/util/paths.js");
const { buildConfirmPlan } = await import("../../src/supervise/confirmPlan.js");
const { describePlan } = await import("../../src/supervise/container.js");
const { registerMount } = await import("../../src/supervise/mounts.js");
const { setGhToken, clearGhToken } =
  await import("../../src/supervise/auth.js");
const { CONTAINER_GH_TOKEN_ENV } =
  await import("../../src/supervise/drivers/containerized.js");
const { installResourceArgs } =
  await import("../../src/supervise/installResources.js");

import type { VendorSpawn } from "../../src/supervise/vendor.js";

const vendor = {
  image: "chat-mcp-agent:local",
  binary: "claude",
  authEnvVar: "CLAUDE_CODE_OAUTH_TOKEN",
} as unknown as VendorSpawn;

function writeOverride(handle: string, body: unknown): void {
  mkdirSync(overridesDir(), { recursive: true });
  writeFileSync(overridePathFor(handle), JSON.stringify(body));
}

/**
 * 🔴 THE DEFECT THIS WHOLE UNIT EXISTS FOR. An override replaces the image, so
 * an operator could approve one container and a different filesystem would
 * start as PID 1 beside three credentials.
 */
test("an override's image is what the plan names, NOT the vendor tag", () => {
  const handle = `cp-override-${process.pid}`;
  writeOverride(handle, { image: "someone-elses/agent:latest" });

  const plan = buildConfirmPlan(vendor, handle);

  assert.equal(plan.image, "someone-elses/agent:latest");
  assert.notEqual(
    plan.image,
    vendor.image,
    "naming the vendor tag describes a container that will not start",
  );
});

/** The banner an operator actually reads must carry it, not just the object. */
test("the rendered banner names the override's image", () => {
  const handle = `cp-banner-${process.pid}`;
  writeOverride(handle, { image: "someone-elses/agent:latest" });

  const banner = describePlan(buildConfirmPlan(vendor, handle));

  assert.match(banner, /image: someone-elses\/agent:latest/);
  assert.doesNotMatch(banner, /chat-mcp-agent:local/);
});

/**
 * 🔴 POSITIVE CONTROL. Without this, an implementation that returned a
 * constant string would pass the test above.
 */
test("with no override the plan names the vendor's own tag", () => {
  const plan = buildConfirmPlan(vendor, `cp-plain-${process.pid}`);

  assert.equal(plan.image, "chat-mcp-agent:local");
});

test("a registered mount appears in the plan's mount paths", () => {
  const handle = `cp-mount-${process.pid}`;
  registerMount(handle, "local-context", mkdtempSync(join(tmpdir(), "cp-m-")));

  const plan = buildConfirmPlan(vendor, handle);

  assert.deepEqual(plan.mountPaths, ["/work", "/mnt/local-context"]);
});

/** No token on file means the banner must not promise one. */
test("the GitHub token env var is absent from the plan when none is on file", () => {
  clearGhToken();

  const plan = buildConfirmPlan(vendor, `cp-nogh-${process.pid}`);

  assert.deepEqual(plan.envVarNames, ["CLAUDE_CODE_OAUTH_TOKEN"]);
});

/**
 * 🔴 THE OTHER DIRECTION. Found by claude2 on PR 344: replacing the whole
 * conditional with an empty array passed every other test here, because only
 * the absent case was asserted. The banner must name the credential the
 * container WILL receive, which is the #136 class.
 */
test("the GitHub token env var IS named when one is on file", () => {
  try {
    setGhToken("ghp-x");

    const plan = buildConfirmPlan(vendor, `cp-gh-${process.pid}`);

    assert.deepEqual(plan.envVarNames, [
      "CLAUDE_CODE_OAUTH_TOKEN",
      CONTAINER_GH_TOKEN_ENV,
    ]);
  } finally {
    clearGhToken();
  }
});

/* --------------------------------------------------------------------------
 * `memory` and `cpus` on the banner.
 *
 * 🔴 THE BANNER UNDERSTATED THE SANDBOX. It named the image, the mounts, the
 * credentials and the network, so an operator reading it had every reason to
 * think it described the container — while the two keys that decide how much
 * of the host the agent may consume were absent.
 * ----------------------------------------------------------------------- */

test("an override's memory and cpus reach the plan", () => {
  const handle = `cp-caps-${process.pid}`;
  writeOverride(handle, { memory: "512m", cpus: "1.5" });

  const plan = buildConfirmPlan(vendor, handle);

  assert.equal(plan.memory, "512m");
  assert.equal(plan.cpus, "1.5");
});

test("the rendered banner names the override's memory and cpus", () => {
  const handle = `cp-caps-banner-${process.pid}`;
  writeOverride(handle, { memory: "512m", cpus: "1.5" });

  const banner = describePlan(buildConfirmPlan(vendor, handle));

  assert.match(banner, /memory: 512m/);
  assert.match(banner, /cpus: 1\.5/);
});

/**
 * 🔴 THE CONTROL THAT MATTERS MORE THAN THE CASE ABOVE. An absent key means
 * the container runs with NO limit, and docker reports nothing — so a banner
 * that simply omits the line lets an operator read silence as a cap. It must
 * say the uncapped thing out loud.
 */
test("with no override the banner says both caps are absent, rather than omitting them", () => {
  const banner = describePlan(
    buildConfirmPlan(vendor, `cp-caps-none-${process.pid}`),
  );

  assert.match(banner, /memory: no limit/);
  assert.match(banner, /cpus: no limit/);
});

/**
 * ⚠️ ONE CAP WITHOUT THE OTHER IS THE REALISTIC FILE. Asserting only the
 * both-set and both-absent cases lets an implementation that reads one key
 * and copies it to the other pass.
 */
test("memory on its own leaves cpus reported as absent", () => {
  const handle = `cp-caps-half-${process.pid}`;
  writeOverride(handle, { memory: "512m" });

  const banner = describePlan(buildConfirmPlan(vendor, handle));

  assert.match(banner, /memory: 512m/);
  assert.match(banner, /cpus: no limit/);
});

/* --------------------------------------------------------------------------
 * The install container's floor on the banner.
 *
 * 🔴 THE BANNER UNDERSTATED THE PEAK BY 2x. #346 raises a cap below the floor
 * for the dependency-install container, so an operator who wrote `512m` was
 * told `512m` and a container ran with `1g`. A number reads as more
 * authoritative than an omission, so this is worse than the silence it
 * replaced. Found by claude2 on PR 349.
 * ----------------------------------------------------------------------- */

test("a cap BELOW the install floor is named as raised, not printed bare", () => {
  const handle = `cp-floor-${process.pid}`;
  writeOverride(handle, { memory: "512m", cpus: "0.5" });

  const banner = describePlan(buildConfirmPlan(vendor, handle));

  assert.match(banner, /memory: 512m \(dependency install: 1g\)/);
  assert.match(banner, /cpus: 0\.5 \(dependency install: 1\)/);
});

/**
 * 🔴 THE CONTROL. Without it, an implementation that always appended the
 * floor would pass the test above while telling an operator their `4g` agent
 * installs under `1g`.
 */
test("a cap ABOVE the install floor is printed bare, with no raise named", () => {
  const handle = `cp-nofloor-${process.pid}`;
  writeOverride(handle, { memory: "4g", cpus: "2" });

  const banner = describePlan(buildConfirmPlan(vendor, handle));

  assert.match(banner, /memory: 4g$/m);
  assert.match(banner, /cpus: 2$/m);
  assert.doesNotMatch(banner, /dependency install/);
});

/**
 * ⚠️ ONE RAISED AND ONE NOT IS THE REALISTIC FILE, and it is the case an
 * implementation that decides per-banner rather than per-key gets wrong.
 */
test("memory above the floor and cpus below it names the raise on cpus only", () => {
  const handle = `cp-mixed-${process.pid}`;
  writeOverride(handle, { memory: "4g", cpus: "0.5" });

  const banner = describePlan(buildConfirmPlan(vendor, handle));

  assert.match(banner, /memory: 4g$/m);
  assert.match(banner, /cpus: 0\.5 \(dependency install: 1\)/);
});

test("no override names no raise, because an absent cap emits no install flag", () => {
  const banner = describePlan(
    buildConfirmPlan(vendor, `cp-floor-none-${process.pid}`),
  );

  assert.match(banner, /memory: no limit/);
  assert.doesNotMatch(banner, /dependency install/);
});

/**
 * ⚠️ THIS PROVES THE TWO ROUTES AGREE ON THE VALUE. It does NOT prove they
 * read one source, and an earlier version of this comment claimed it did.
 * A re-duplicated `"1g"` agrees by construction, so this catches a floor that
 * DRIFTS and not one that is COPIED. claude2 measured that on PR 349: a second
 * copy inside `confirmPlan.ts` survived all 15 tests and typecheck.
 *
 * 🛑 THE SOURCING IS PINNED IN `confirm-plan-floor-sourcing.test.ts`, which
 * replaces the exported function and fails if the banner stops calling it.
 */
test("the banner's install values are exactly what the install argv carries", () => {
  const handle = `cp-pinned-${process.pid}`;
  writeOverride(handle, { memory: "512m", cpus: "0.5" });

  const plan = buildConfirmPlan(vendor, handle);

  assert.deepEqual(installResourceArgs({ memory: "512m", cpus: "0.5" }), [
    "--memory",
    plan.installMemory,
    "--cpus",
    plan.installCpus,
  ]);
});

/**
 * 🛑 A COMMENT CLAIMING "UNREACHABLE" IS NOT A GUARD. `capLine` returns early
 * on a null agent cap, which would discard a non-null install cap without a
 * word — the exact silent-drop this whole slice exists to stop. Both values
 * come off one override today, so it throws instead of being commented about.
 * Raised by claude2 on PR 349.
 */
test("🛑 an install cap with no agent cap throws rather than being dropped", () => {
  assert.throws(
    () =>
      describePlan({
        mountPaths: ["/work"],
        envVarNames: ["CLAUDE_CODE_OAUTH_TOKEN"],
        binary: "claude",
        networkMode: "bridge",
        image: "chat-mcp-agent:local",
        memory: null,
        cpus: null,
        installMemory: "1g",
        installCpus: null,
      }),
    /cannot be described/,
  );
});

/** ⚠️ CONTROL — both null is the ordinary uncapped case and must not throw. */
test("⚠️ control — no caps at all describes as no limit, without throwing", () => {
  const banner = describePlan({
    mountPaths: ["/work"],
    envVarNames: ["CLAUDE_CODE_OAUTH_TOKEN"],
    binary: "claude",
    networkMode: "bridge",
    image: "chat-mcp-agent:local",
    memory: null,
    cpus: null,
    installMemory: null,
    installCpus: null,
  });

  assert.match(banner, /memory: no limit/);
  assert.match(banner, /cpus: no limit/);
});

function planWithMounts(mountPaths: readonly string[]) {
  return {
    mountPaths,
    envVarNames: ["CLAUDE_CODE_OAUTH_TOKEN"],
    binary: "claude",
    networkMode: "bridge",
    image: "chat-mcp-agent:local",
    memory: null,
    cpus: null,
    installMemory: null,
    installCpus: null,
  };
}

/**
 * 🔴 #353. `", "` separated the mounts AND is legal inside a directory name,
 * so one mount and two mounts rendered as the same sentence. `checkedMountPath`
 * refuses the project root and symlinks, never a comma or a space, so the
 * ambiguous name reaches the operator.
 *
 * ⚠️ A BARE COMMA IS NOT ENOUGH, because the separator carries a space too.
 * The collision needs the comma AND the space inside the one name.
 */
test("🔴 one mount and two mounts do not describe identically", () => {
  const one = describePlan(planWithMounts(["/work/a, b"]));
  const two = describePlan(planWithMounts(["/work/a", "b"]));

  assert.notEqual(
    one,
    two,
    "an operator cannot consent to a grant they cannot tell apart from another",
  );
});

/** The shape lee ruled on: one mount per line, so no separator is overloaded. */
test("the banner prints one mount per line", () => {
  const banner = describePlan(planWithMounts(["/work", "/mnt/notify"]));
  const mounts = banner
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line === '"/work"' || line === '"/mnt/notify"');

  assert.deepEqual(mounts, ['"/work"', '"/mnt/notify"']);
});

/**
 * ⚠️ POSITIVE CONTROL. Without this, dropping every mount but the first would
 * pass both tests above.
 */
test("⚠️ control — every mount still reaches the banner", () => {
  const banner = describePlan(planWithMounts(["/work", "/mnt/notify", "/x"]));

  for (const path of ["/work", "/mnt/notify", "/x"]) {
    assert.ok(banner.includes(path), `the banner dropped ${path}`);
  }
});

/**
 * 🛑 THE LINE BREAK ALONE IS NOT ENOUGH, which is why each entry is quoted. A
 * newline is legal in a path, so an unquoted one-per-line form reproduces the
 * comma's collision exactly. This pins the claim the docblock makes.
 *
 * ⚠️ THE NAME CARRIES THE INDENT TOO. A bare `"\n"` is defeated by the four
 * spaces each entry is printed with, so a test using one would pass without
 * the quoting and prove nothing. Dropping `JSON.stringify` was measured to
 * turn THIS case red.
 */
test("🛑 a mount name that forges a line break does not collide with two mounts", () => {
  const one = describePlan(planWithMounts(["/work/a\n    b"]));
  const two = describePlan(planWithMounts(["/work/a", "b"]));

  assert.notEqual(one, two);
});
