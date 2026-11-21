import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), "chat-mcp-ovr-envmnt-"));

const { setToken } = await import("../../src/supervise/auth.js");
const { claudeSpawn } = await import("../../src/adapters/claude-spawn.js");
const { dockerRunPlan } =
  await import("../../src/supervise/drivers/containerized.js");
const { buildConfirmPlan } = await import("../../src/supervise/confirmPlan.js");
const { diffPlans, describePlan } =
  await import("../../src/supervise/container.js");
const { overridesDir, overridePathFor } =
  await import("../../src/util/paths.js");

/**
 * The last two of #222's five keys. `memory`, `cpus` and `image` shipped in
 * units 1, 3 and 4; `env` and `readOnlyMounts` were validated by the store and
 * then read by nobody, so an operator's file changed no container.
 *
 * 🛑 THE ARGV AND THE BANNER ARE ONE UNIT, NOT TWO. Wiring either alone grants
 * a capability the sentence the operator agreed to never mentions — which is
 * the defect the fingerprint work exists to stop, re-introduced one key down.
 */

const PROJECT_DIR = mkdtempSync(join(tmpdir(), "chat-mcp-ovr-project-"));

mkdirSync(join(PROJECT_DIR, "docs"), { recursive: true });
mkdirSync(join(PROJECT_DIR, "fixtures"), { recursive: true });

setToken("sk-ant-oat-ENV-AND-MOUNTS");

/**
 * 🛑 A VALUE THAT WOULD BE OBVIOUS IN AN ARGV. The rule this file pins hardest
 * is that a value never reaches the argv, and a bland value could pass that
 * assertion by coincidence.
 */
const SECRET_VALUE = "SENTINEL-VALUE-MUST-NOT-REACH-ARGV";

function planWith(override: unknown, readOnlyPaths?: string[]) {
  return dockerRunPlan(claudeSpawn, {
    cwd: PROJECT_DIR,
    supervisorHandle: "claude1",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    containerOverride: override as any,
    readOnlyPaths,
  });
}

function writeOverride(handle: string, body: unknown): void {
  mkdirSync(overridesDir(), { recursive: true });
  writeFileSync(overridePathFor(handle), JSON.stringify(body));
}

/** Each `-v` spec in the plan, so a destination can be counted. */
function mountSpecs(args: readonly string[]): string[] {
  return args.filter((_, i) => args[i - 1] === "-v");
}

/** Each `-e` name in the plan, in argv order. */
function envNames(args: readonly string[]): string[] {
  return args.filter((_, i) => args[i - 1] === "-e");
}

test("🔴 an override's env NAME reaches the argv and its VALUE does not", () => {
  const { args, env } = planWith({ env: { MY_FLAG: SECRET_VALUE } });

  assert.ok(
    envNames(args).includes("MY_FLAG"),
    `expected -e MY_FLAG in ${JSON.stringify(args)}`,
  );

  // 🛑 THE WHOLE ARGV, NOT THE FLAG BLOCK. `ps` shows every entry for the life
  // of the container, which AGENTS.md forbids in those words.
  assert.doesNotMatch(args.join("\u0000"), /SENTINEL-VALUE/);

  // Docker copies the value from this process, so the env is where it lives.
  assert.equal(env.MY_FLAG, SECRET_VALUE);
});

test("🔴 an override's readOnlyMounts entry becomes a :ro bind", () => {
  const { args } = planWith({ readOnlyMounts: ["docs"] });

  const specs = mountSpecs(args);

  assert.ok(
    specs.some((s) => s.endsWith("/work/docs:ro")),
    `expected a read-only docs bind in ${JSON.stringify(specs)}`,
  );
});

/**
 * Finding 1 on this ticket. The banner read `readMounts()` and the vendor
 * only, so these two keys reached the spawn and never reached the sentence the
 * operator approved.
 */
test("🔴 the consent banner NAMES the override's env var and mount", () => {
  const handle = `ovr-banner-${process.pid}`;
  writeOverride(handle, {
    env: { MY_FLAG: SECRET_VALUE },
    readOnlyMounts: ["docs"],
  });

  const banner = describePlan(buildConfirmPlan(claudeSpawn, handle));

  assert.match(banner, /MY_FLAG/);
  assert.match(banner, /docs/);
  // The banner names env vars, never their values.
  assert.doesNotMatch(banner, /SENTINEL-VALUE/);
});

/**
 * 🛑 THE RE-PROMPT IS WHAT MAKES THE BANNER LOAD-BEARING. A plan that names
 * the key but does not DIFFER when the key changes leaves an override written
 * after the first approval shown to nobody — #222 OQ4, ruled by lee.
 */
test("🔴 adding env or a mount to an override is a REPORTED plan change", () => {
  const bare = `ovr-bare-${process.pid}`;
  const rich = `ovr-rich-${process.pid}`;

  writeOverride(bare, {});
  writeOverride(rich, {
    env: { MY_FLAG: SECRET_VALUE },
    readOnlyMounts: ["docs"],
  });

  const changes = diffPlans(
    buildConfirmPlan(claudeSpawn, bare),
    buildConfirmPlan(claudeSpawn, rich),
  );

  const fields = changes.map((c) => c.field);

  assert.ok(fields.includes("env vars"), JSON.stringify(changes));
  assert.ok(fields.includes("mounts"), JSON.stringify(changes));
});

/**
 * The paired control. A wiring that appended unconditionally would pass every
 * assertion above and put an empty name in every default container's argv.
 */
test("no override leaves the argv and the banner unchanged", () => {
  const handle = `ovr-none-${process.pid}`;
  writeOverride(handle, {});

  const { args } = planWith(undefined);

  assert.deepEqual(envNames(args), [claudeSpawn.authEnvVar]);
  assert.equal(
    mountSpecs(args).filter((s) => s.endsWith(":ro")).length,
    0,
    JSON.stringify(mountSpecs(args)),
  );

  const banner = describePlan(buildConfirmPlan(claudeSpawn, handle));

  assert.doesNotMatch(banner, /MY_FLAG/);
});

/**
 * 🛑 THE EXISTING GUARD MUST BE REACHED THROUGH THE NEW ROUTE, not merely
 * still present on the old one. `node_modules` is a container-owned volume, and
 * a second spec for one destination dies in the daemon naming neither mount.
 */
test("🔴 a readOnlyMounts entry colliding with node_modules is refused", () => {
  assert.throws(
    () => planWith({ readOnlyMounts: ["node_modules"] }),
    /node_modules/,
  );
});

/**
 * 🛑 THE CONSUMER RE-CHECKS, BECAUSE THE STORE IS NOT THE ONLY ROUTE IN.
 * `dockerRunPlan` is a library export taking `containerOverride` directly —
 * the same hole `assertImageRef` and `assertMemory` exist to plug. An override
 * re-declaring a credential name would decide which token the agent receives.
 */
test("🔴 an override env name that is a RESERVED credential is refused", () => {
  assert.throws(
    () => planWith({ env: { CLAUDE_CODE_OAUTH_TOKEN: "stolen" } }),
    /CLAUDE_CODE_OAUTH_TOKEN/,
  );
});

test("🔴 an override env name that is not an env var name is refused", () => {
  assert.throws(() => planWith({ env: { "not a name": "x" } }), /env/);
});

/**
 * 🛑 ONE SPEC PER DESTINATION. `checkedMountPath` derives `inner` from the
 * declared string and refuses any symlink, so one destination always means one
 * host path — which is why deduping cannot drop a distinct mount.
 */
test("a path in BOTH readOnlyPaths and the override is mounted once", () => {
  const { args } = planWith({ readOnlyMounts: ["docs"] }, ["docs"]);

  const docs = mountSpecs(args).filter((s) => s.endsWith("/work/docs:ro"));

  assert.equal(docs.length, 1, JSON.stringify(mountSpecs(args)));
});

test("two different override mounts both reach the argv", () => {
  const { args } = planWith({ readOnlyMounts: ["docs", "fixtures"] });

  const specs = mountSpecs(args);

  assert.ok(
    specs.some((s) => s.endsWith("/work/docs:ro")),
    specs.join(" "),
  );
  assert.ok(
    specs.some((s) => s.endsWith("/work/fixtures:ro")),
    specs.join(" "),
  );
});
