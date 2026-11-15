import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn as realSpawn, spawnSync } from "node:child_process";

process.env.CHAT_MCP_HOME = mkdtempSync(
  join(tmpdir(), "chat-mcp-docker-driver-"),
);

const { setToken, setGhToken, clearGhToken } =
  await import("../../../src/supervise/auth.js");
const { stateDir } = await import("../../../src/util/paths.js");
const { registerMount, mountsPath } =
  await import("../../../src/supervise/mounts.js");
const { claudeSpawn } = await import("../../../src/adapters/claude-spawn.js");
const {
  dockerRunPlan,
  dockerInstallPlan,
  containerCredentialEnvVars,
  nodeModulesVolumeFor,
  nodeModulesInstallStep,
  prelude,
  NO_LOCK_HASH_WARNING,
  CONTAINER_GH_TOKEN_ENV,
  CONTAINER_PROJECT_DIR,
  CONTAINER_MCP_CONFIG_ENV,
  containerPathFor,
  containerMcpConfigPath,
  containerBusUrl,
} = await import("../../../src/supervise/drivers/containerized.js");

const PROJECT_DIR = mkdtempSync(join(tmpdir(), "chat-mcp-docker-project-"));

function dockerRunPlanFor(opts: Parameters<typeof dockerRunPlan>[1]) {
  return dockerRunPlan(claudeSpawn, opts);
}

/** The argv alone, for the many tests that assert only on mounts and flags. */
function dockerArgsFor(opts: Parameters<typeof dockerRunPlan>[1]) {
  return dockerRunPlanFor(opts).args;
}

/**
 * Mock `node:child_process` so both docker calls land on one `spawn` mock,
 * and record every `docker stop` argv.
 *
 * 🛑 `docker stop` MOVED OFF `execFileSync` ONTO A DETACHED `spawn`, because
 * PID 1 ignores SIGTERM so a synchronous stop froze the supervisor for the
 * whole `-t` window. One mock now sees the `docker run` client AND the
 * stopper, so it discriminates on argv: `stop` is the stopper, anything else
 * is the run.
 *
 * Node's module mocking only intercepts an ESM named import at a fresh module
 * instance, so callers must import `containerized.js` with a cache-busting
 * query AFTER calling this.
 */
function mockDocker(t: TestContext): {
  /** Every docker argv, in call order, across both spawn and execFileSync. */
  calls: string[][];
  stopInvocations: string[][];
  runningClient: () => ReturnType<typeof realSpawn> | undefined;
} {
  const calls: string[][] = [];
  const stopInvocations: string[][] = [];
  let fakeDockerRun: ReturnType<typeof realSpawn> | undefined;

  t.mock.module("node:child_process", {
    namedExports: {
      spawn: (_cmd: string, args: string[]) => {
        calls.push(args);
        if (args[0] === "stop") {
          stopInvocations.push(args);
          // `dockerStopFor` attaches an 'error' listener and calls `unref()`,
          // so the stub has to answer both or the code under test throws.
          return { on: () => undefined, unref: () => undefined };
        }
        // A real, controllable stand-in for the `docker run` CLI process:
        // long-lived with piped stdio, since spawnContainerized reads
        // child.stdout directly.
        fakeDockerRun = realSpawn(process.execPath, [
          "-e",
          "setInterval(() => {}, 1000)",
        ]);
        return fakeDockerRun;
      },
      // The pre-run `docker rm -f` is the one call that must still be
      // synchronous — the name has to be free before `docker run`.
      execFileSync: (_cmd: string, args: string[]) => {
        calls.push(args);
        return Buffer.from("");
      },
    },
  });

  // 🛑 KILL THE STAND-IN FROM `t.after`, NOT FROM THE TEST BODY. A kill after
  // the assertions never runs when an assertion throws, and the stand-in is a
  // real `setInterval` process — so a FAILING test leaks an open handle and
  // the whole runner hangs instead of reporting the failure. Observed: one
  // leaked pid wedged `node --test` indefinitely. Same lesson as
  // `container-removal.test.ts`'s `finally`, different resource.
  t.after(() => fakeDockerRun?.kill());

  // 🛑 BOTH ARRAYS ARE THE SAME OBJECTS THE MOCK PUSHES INTO, never a
  // filtered copy. A getter returning `calls.filter(...)` would be evaluated
  // once at destructuring — before the call under test — and assert empty.
  return { calls, stopInvocations, runningClient: () => fakeDockerRun };
}

test("with no token on file, building argv throws naming the fix", () => {
  assert.throws(
    () => dockerArgsFor({ cwd: PROJECT_DIR, supervisorHandle: "claude1" }),
    /chat-mcp auth set-token/,
  );
});

test("the project dir is bind-mounted to the fixed in-container work dir", () => {
  setToken("sk-ant-oat-x");
  const args = dockerArgsFor({ cwd: PROJECT_DIR, supervisorHandle: "claude1" });
  assert.ok(args.includes(`${PROJECT_DIR}:${CONTAINER_PROJECT_DIR}`));
});

/**
 * 🛑 THE MOUNT IS WHAT LET A CONTAINER FORGE ANY HANDLE'S IDENTITY. `tokens/`
 * is a child of `stateDir()`, and `authenticateToken` trusts whatever digest
 * is on disk — so a container could overwrite `tokens/claude1.json` with a
 * digest it chose, present the matching token, and BE claude1 against both the
 * MCP listener and the command broker. It also exposed `chat.db` and
 * `secrets.env` outright.
 *
 * The bus is reached over HTTP now, so nothing in there is needed.
 */
test("🚨 the chat-mcp state dir is NOT bind-mounted, so tokens and chat.db stay on the host", async () => {
  const { stateDir } = await import("../../../src/util/paths.js");
  setToken("sk-ant-oat-x");
  const args = dockerArgsFor({ cwd: PROJECT_DIR, supervisorHandle: "claude1" });

  for (const arg of args) {
    assert.ok(
      !arg.startsWith(`${stateDir()}:`),
      `the state dir is still mounted as ${arg}`,
    );
  }
});

/**
 * The paired control. An argv that mounted nothing at all would pass the test
 * above, and the agent would have no project to work on.
 */
test("🚨 the project mount survives the state-dir removal", () => {
  setToken("sk-ant-oat-x");
  const args = dockerArgsFor({ cwd: PROJECT_DIR, supervisorHandle: "claude1" });

  assert.ok(args.includes(`${PROJECT_DIR}:${CONTAINER_PROJECT_DIR}`));
});

/**
 * 🛑 `/work` CARRIES THE HOST'S `node_modules`, INSTALLED ON macOS. The
 * container is Linux on the same chip, so `tsx` loads `esbuild`, `esbuild`
 * resolves `@esbuild/darwin-arm64`, and the suite dies before the first test.
 * A review from inside the container then proves typecheck only.
 *
 * A volume at the same path hides the host's copy from the container without
 * touching it, so each side keeps its own platform build.
 *
 * ⚠️ NAMED, NOT ANONYMOUS, so it survives the `--rm` and the install below
 * runs on a handle's first container rather than on every one. A source side
 * that is a bare name, not an absolute path, is what makes it a volume.
 */
test("🛑 a NAMED volume covers /work/node_modules, so the host platform build stays out", () => {
  setToken("sk-ant-oat-x");
  const args = dockerArgsFor({ cwd: PROJECT_DIR, supervisorHandle: "claude1" });
  const spec = args.find((a) =>
    a.endsWith(`:${CONTAINER_PROJECT_DIR}/node_modules`),
  );

  assert.ok(spec, `no node_modules overlay in ${args.join(" ")}`);
  assert.ok(
    !spec.startsWith("/"),
    `the source side is an absolute path, so this is a host bind, not a volume: ${spec}`,
  );
});

/**
 * 🚨 KEYED ON THE HANDLE **AND** THE PROJECT DIR. `ProjectConfig.agents` is
 * `Record<string, string[]>` — "the directories that agent may work in" — and
 * `resolveCwd` accepts any directory contained by any of them. So ONE handle
 * legitimately spawns against several trees.
 *
 * Keyed on the handle alone, the first tree to install wins: the install guard
 * finds a populated marker and every later tree silently imports the first
 * one's dependencies, across `--rm`, indefinitely. That is the "dependency
 * tree nobody declared" symptom reached from the other side.
 */
test("🚨 one handle working in TWO project dirs gets two different volumes", () => {
  const other = mkdtempSync(join(tmpdir(), "chat-mcp-docker-second-"));

  assert.notEqual(
    nodeModulesVolumeFor("claude1", PROJECT_DIR),
    nodeModulesVolumeFor("claude1", other),
  );
});

/**
 * The paired control. Two handles on one tree must also differ, and a key
 * built from the project dir ALONE would pass the test above and fail this.
 */
test("🛑 two handles in ONE project dir also get two different volumes", () => {
  assert.notEqual(
    nodeModulesVolumeFor("claude1", PROJECT_DIR),
    nodeModulesVolumeFor("claude2", PROJECT_DIR),
  );
});

/**
 * 🛑 THE SAME INPUTS MUST GIVE THE SAME NAME, or the volume is anonymous in
 * all but spelling and the install runs on every spawn after all.
 */
test("🛑 the volume name is STABLE across calls for one handle and dir", () => {
  assert.equal(
    nodeModulesVolumeFor("claude1", PROJECT_DIR),
    nodeModulesVolumeFor("claude1", PROJECT_DIR),
  );
});

/**
 * 🚨 A SYMLINKED PROJECT DIR IS THE SAME TREE, so it must not earn a second
 * volume and a second install. `realpathSync` collapses them, which is how
 * every other mount in this file is already resolved.
 */
test("🚨 a project dir reached through a SYMLINK keys the SAME volume", () => {
  const real = mkdtempSync(join(tmpdir(), "chat-mcp-docker-real-"));
  const link = join(
    mkdtempSync(join(tmpdir(), "chat-mcp-docker-link-")),
    "alias",
  );
  symlinkSync(real, link);

  assert.equal(
    nodeModulesVolumeFor("claude1", link),
    nodeModulesVolumeFor("claude1", real),
  );
});

/**
 * 🛑 DOCKER'S OWN NAME RULE IS `[a-zA-Z0-9][a-zA-Z0-9_.-]*`. `assertHandle`
 * already keeps the handle narrower than that, but the digest is new, so the
 * COMPOSED name is what has to be checked.
 */
test("🛑 the composed volume name is a legal docker volume name", () => {
  assert.match(
    nodeModulesVolumeFor("claude1", PROJECT_DIR),
    /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/,
  );
});

/**
 * 🛑 THE VOLUME STARTS EMPTY, so the overlay alone takes the container from a
 * WRONG-platform `node_modules` to NO `node_modules`. The suite still cannot
 * run, for a different reason. Something has to populate it, and `/work`
 * carries the lockfile to do it from.
 */
test("🛑 the install container installs node_modules when the volume is empty", () => {
  setToken("sk-ant-oat-x");
  // 🛑 READ OFF THE INSTALL PLAN SINCE #231, NOT THE AGENT'S. The install left
  // the agent container precisely so it is not beside the credentials, so
  // finding it in the agent argv is now the FAILURE this guards against.
  const { args } = dockerInstallPlan(claudeSpawn, {
    cwd: PROJECT_DIR,
    supervisorHandle: "claude1",
  });
  const step = args.find((a) => a.includes("npm ci"));

  assert.ok(step, `no install step in ${args.join(" ")}`);
  // Only that the argv CARRIES a guarded install. What the guard decides is
  // measured in a real `sh` further down, not read off this string.
  assert.match(
    step,
    new RegExp(`${CONTAINER_PROJECT_DIR}/package-lock\\.json`),
    "the install is unconditional, so it reruns on every warm start",
  );
  assert.match(
    step,
    /node_modules\/\.lock-sha/,
    "no lockfile-hash stamp to compare against",
  );
});

/**
 * 🛑 THE DIVERGENCE GUARD, REPOINTED. It used to catch an install step added
 * to `dockerRunPlan`'s granted branch alone, which would have been present in
 * every granted test and absent from every plain one. The install has its own
 * plan now, and the same failure shape is a plan that varies with the grant —
 * so an agent that happens to be granted would install and an ungranted one
 * would not.
 *
 * ⚠️ `deepEqual` ON THE WHOLE ARGV, because the install needs nothing from the
 * grant and must therefore be byte-identical either way. Asserting only that
 * both contain `npm ci` would pass while the mounts differed.
 */
test("🛑 the install plan is identical whether the spawn is granted or not", () => {
  setToken("sk-ant-oat-x");

  const plain = dockerInstallPlan(claudeSpawn, {
    cwd: PROJECT_DIR,
    supervisorHandle: "claude1",
  });
  const granted = dockerInstallPlan(claudeSpawn, {
    cwd: PROJECT_DIR,
    supervisorHandle: "claude1",
    bus: BUS,
    grant: { handle: "claude1-agent", configPath: "/unused.json", tools: [] },
  });

  assert.deepEqual(granted.args, plain.args);
  assert.ok(
    plain.args.some((a) => a.includes("npm ci")),
    "neither plan installs anything, so this proves nothing",
  );
});

/**
 * 🚨 MEASURED IN A REAL `sh`, NOT READ OFF THE STRING. `&&` and `||` have
 * EQUAL precedence and bind left to right, so `cfg && [ -e m ] || install`
 * groups as `((cfg && [ -e m ]) || install)` — and a FAILED config write then
 * reaches `exec` anyway, because the install's success rescues the whole
 * group. The agent starts with no MCP config, which is the exact case the
 * original `&& exec "$@"` existed to prevent.
 *
 * Every step `prelude` joins must therefore be atomic on its own.
 */
test("🚨 a FAILED step stops the chain even when a later step contains ||", () => {
  const script = prelude(["false", "[ -e /nonexistent-marker ] || true"]);
  const ran = spawnSync("sh", ["-c", script, "sh", "echo", "AGENT_RAN"], {
    encoding: "utf8",
  });

  assert.equal(
    ran.stdout.trim(),
    "",
    `the agent ran despite a failed first step; script was: ${script}`,
  );
});

/**
 * The paired control. A `prelude` that never reached `exec` would pass the
 * test above and start nothing at all.
 */
test("🚨 an all-passing chain DOES reach the agent", () => {
  const script = prelude(["true", "[ -e /nonexistent-marker ] || true"]);
  const ran = spawnSync("sh", ["-c", script, "sh", "echo", "AGENT_RAN"], {
    encoding: "utf8",
  });

  assert.equal(ran.stdout.trim(), "AGENT_RAN");
});

/**
 * 🚨 THE HANDLE IS NOW A MOUNT-SPEC FIELD, SO ITS SHAPE IS LOAD-BEARING. It
 * used to reach the argv only through `--name`, where the daemon rejects a bad
 * value itself. In a `-v` spec a colon separates source from destination, so an
 * unvalidated handle is a way to write a mount nobody declared.
 *
 * `requireSupervisorHandle` only ever checked truthiness, despite its docblock
 * calling itself the one place that validates the field.
 */
test("🚨 a supervisor handle that could forge a mount spec REFUSES the plan", () => {
  setToken("sk-ant-oat-x");

  for (const bad of [
    "claude1:/etc",
    "claude1:/work/node_modules:ro",
    "../claude1",
    "Claude1",
  ]) {
    assert.throws(
      () => dockerArgsFor({ cwd: PROJECT_DIR, supervisorHandle: bad }),
      /handle/i,
      `the plan accepted the handle ${bad}`,
    );
  }
});

/**
 * The paired control. A `requireSupervisorHandle` that threw on everything
 * would pass the test above and spawn nothing at all.
 */
test("🚨 a normal handle still builds a plan", () => {
  setToken("sk-ant-oat-x");

  assert.ok(
    dockerArgsFor({ cwd: PROJECT_DIR, supervisorHandle: "claude1" }).length > 0,
  );
});

/**
 * 🚨 THE OVERLAY MUST NAME NO HOST PATH AT ALL. A `host:/work/node_modules`
 * spec is a second door onto a host directory, and it also collides with the
 * volume on one destination, which the daemon refuses at spawn time.
 *
 * ⚠️ MEASURED, NOT ASSUMED: `readOnlyPaths: ['node_modules']` passes every
 * containment check and emitted exactly that spec. The `:ro` suffix is why an
 * `endsWith` check could not see it. `dockerRunPlan` must refuse instead.
 */
test("🚨 a read-only path that collides with the node_modules volume REFUSES the spawn", () => {
  setToken("sk-ant-oat-x");
  // The declared path has to EXIST or `checkedProjectPath` refuses first, for
  // a reason that has nothing to do with the collision.
  const dir = mkdtempSync(join(tmpdir(), "chat-mcp-docker-nm-"));
  mkdirSync(join(dir, "node_modules"));

  assert.throws(
    () =>
      dockerArgsFor({
        cwd: dir,
        supervisorHandle: "claude1",
        readOnlyPaths: ["node_modules"],
      }),
    /node_modules/,
  );
});

test("a registered extra mount appears at /mnt/<key>", () => {
  const extraDir = mkdtempSync(join(tmpdir(), "chat-mcp-docker-extra-"));
  setToken("sk-ant-oat-x");
  registerMount("claude1", "local-context", extraDir);
  const args = dockerArgsFor({ cwd: PROJECT_DIR, supervisorHandle: "claude1" });
  assert.ok(
    args.includes(`${extraDir}:${containerPathFor("local-context")}:ro`),
  );
});

/**
 * 🔴 #231. An extra mount was attached READ-WRITE, so a package the tree chose
 * could write to the whole host directory it names. The only one configured in
 * practice is `local-context -> ~/context`, which is every task's `status.md`.
 *
 * 🛑 THE REGISTRY ROUTE IS MEASURED AND LIVE, so this is not theoretical: a
 * project `.npmrc` picks the registry, the container reaches it, and the
 * substituted package runs later as the agent. #231's last comment carries the
 * probe and its `--network=none` control.
 */
test("🔴 a registered extra mount is READ-ONLY, or the tree can write to the host dir", () => {
  const extraDir = mkdtempSync(join(tmpdir(), "chat-mcp-docker-ro-extra-"));
  setToken("sk-ant-oat-x");
  registerMount("claude1", "local-context", extraDir);

  const args = dockerArgsFor({ cwd: PROJECT_DIR, supervisorHandle: "claude1" });
  const spec = args.find((a) => a.startsWith(`${extraDir}:`));

  assert.ok(spec, `no mount spec for ${extraDir}; got ${args.join(" ")}`);
  // 🛑 THE WHOLE SPEC, NOT AN `endsWith(':ro')`. A spec can end in `:ro` and
  // still name the wrong destination, and the collision test above was written
  // because `endsWith` could not see a `:ro` suffix at all.
  assert.equal(spec, `${extraDir}:${containerPathFor("local-context")}:ro`);
});

/**
 * 🛑 THIS TEST'S NAME ALWAYS CLAIMED THE SECURE PROPERTY AND ITS BODY ASSERTED
 * THE OPPOSITE. It read `args.includes('CLAUDE_CODE_OAUTH_TOKEN=<value>')`,
 * which is the value IN the argv — readable by `ps` for the life of the
 * container, and the thing `AGENTS.md` forbids in those words. The name is
 * what was right, so the body moved to meet it.
 */
test("the token is injected by NAME via -e, and the value never appears as a bare arg", () => {
  setToken("sk-ant-oat-secret-value");
  const { args } = dockerRunPlanFor({
    cwd: PROJECT_DIR,
    supervisorHandle: "claude1",
  });

  assert.ok(args.includes("-e"), "no -e at all");
  assert.ok(
    args.includes("CLAUDE_CODE_OAUTH_TOKEN"),
    "the var is not passed by name",
  );

  for (const arg of args) {
    assert.ok(
      !arg.includes("sk-ant-oat-secret-value"),
      `the token value reached the docker argv as ${arg}`,
    );
  }
});

/**
 * The paired control for the test above. An argv that simply dropped the token
 * would pass it, and the container would then start with no credential.
 */
test("the token reaches the container through the spawn env instead", () => {
  setToken("sk-ant-oat-secret-value");
  const { env } = dockerRunPlanFor({
    cwd: PROJECT_DIR,
    supervisorHandle: "claude1",
  });

  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "sk-ant-oat-secret-value");
});

/**
 * 🛑 THIS TEST WAS GREEN THROUGHOUT THE WEEK THE CONTAINER WAS BROKEN, and
 * its title asserted that the child "always carries" the flag that never
 * worked. It pinned `--allow-dangerously-skip-permissions`, which only makes
 * the bypass AVAILABLE — the CLI's own help says "without it being enabled by
 * default". The activating flag is `--dangerously-skip-permissions`.
 *
 * ⚠️ A SECOND COPY OF THE SAME VACUOUS ASSERTION IS WHY IT SURVIVED THE
 * FIRST FIX. Raised by claude2 on PR 210: killing one test that could not
 * fail, while an identical one stands, puts the next reader back where we
 * started.
 */
test("the child command carries the ACTIVATING bypass flag, never --permission-mode", () => {
  setToken("sk-ant-oat-x");
  const args = dockerArgsFor({ cwd: PROJECT_DIR, supervisorHandle: "claude1" });

  assert.ok(
    args.includes("--dangerously-skip-permissions"),
    "the bypass is available but never activated; every tool call will be denied",
  );

  // ⚠️ MEASURED, NOT ASSUMED. A live container with the activator ALONE
  // answered on the bus, so the enabler changes nothing and does not belong
  // in a security-sensitive arg list.
  assert.ok(!args.includes("--allow-dangerously-skip-permissions"));

  assert.ok(!args.includes("--permission-mode"));
  assert.ok(!args.includes("--allowedTools"));
});

test("a resume id is forwarded as --resume", () => {
  setToken("sk-ant-oat-x");
  const args = dockerArgsFor({
    cwd: PROJECT_DIR,
    supervisorHandle: "claude1",
    resumeSessionId: "sess-123",
  });
  const i = args.indexOf("--resume");
  assert.ok(i >= 0);
  assert.equal(args[i + 1], "sess-123");
});

test("the invocation runs the image with --rm, never leaving a stopped container behind", () => {
  setToken("sk-ant-oat-x");
  const args = dockerArgsFor({ cwd: PROJECT_DIR, supervisorHandle: "claude1" });
  assert.ok(args.includes("--rm"));
});

test("kill() stops the container by name via the daemon, not a raw signal to the docker-run client", async (t) => {
  setToken("sk-ant-oat-x");
  // 🛑 A RAW SIGTERM TO THE `docker run` CLIENT IS NOT THE CONTRACT. The
  // daemon ignores it (container-removal.test.ts, #148's real finding), so
  // `kill()` must shell out to `docker stop <name>` instead. This test
  // captures that argv rather than asserting the client died, which is a
  // signal-propagation detail a real daemon supplies and this mock does not.
  const { stopInvocations, runningClient } = mockDocker(t);

  const { spawnContainerized } = await import(
    `../../../src/supervise/drivers/containerized.js?kill-test=${Date.now()}`
  );
  const agent = spawnContainerized(claudeSpawn, {
    cwd: PROJECT_DIR,
    supervisorHandle: "claude1",
  });

  agent.kill();

  assert.deepEqual(stopInvocations, [["stop", "-t", "60", "chat-mcp-claude1"]]);
  assert.ok(runningClient(), "spawn mock was not invoked");
});

test("a per-handle shutdownGraceSeconds overrides the -t default", async (t) => {
  setToken("sk-ant-oat-x");
  const { stopInvocations } = mockDocker(t);

  const { spawnContainerized } = await import(
    `../../../src/supervise/drivers/containerized.js?grace-test=${Date.now()}`
  );
  const agent = spawnContainerized(claudeSpawn, {
    cwd: PROJECT_DIR,
    supervisorHandle: "claude1",
    shutdownGraceSeconds: 5,
  });

  agent.kill();

  assert.deepEqual(stopInvocations, [["stop", "-t", "5", "chat-mcp-claude1"]]);
});

test("🛑 the container name is force-cleared BEFORE docker run, or a restart hits a name conflict", async (t) => {
  setToken("sk-ant-oat-x");
  // The name is fixed per handle, and `kill()` no longer waits for the
  // teardown — so without this, restarting a handle inside the grace window
  // gets `Conflict. The container name is already in use` from the daemon.
  // Ordering is the whole assertion: an `rm -f` after `run` clears nothing.
  const { calls } = mockDocker(t);

  const { spawnContainerized } = await import(
    `../../../src/supervise/drivers/containerized.js?rm-test=${Date.now()}`
  );
  spawnContainerized(claudeSpawn, {
    cwd: PROJECT_DIR,
    supervisorHandle: "claude1",
  });

  // 🛑 POSITIONS FOUND BY ARGV, NOT BY INDEX. This read `calls[0]` and
  // `calls[1]` until #231 put the credential-free install container ahead of
  // both — so the index was a proxy for "the agent's run", and the install
  // broke the proxy while the invariant it stands for was untouched.
  const removalAt = calls.findIndex((argv) => argv[0] === "rm");
  const agentRunAt = calls.findIndex(
    (argv) => argv[0] === "run" && argv.includes("chat-mcp-claude1"),
  );

  assert.deepEqual(
    calls[removalAt],
    ["rm", "-f", "chat-mcp-claude1"],
    `no docker rm -f was issued: ${JSON.stringify(calls)}`,
  );
  assert.ok(agentRunAt >= 0, `the agent never ran: ${JSON.stringify(calls)}`);
  assert.ok(
    removalAt < agentRunAt,
    `the rm -f clears nothing: rm at ${removalAt}, agent run at ${agentRunAt}`,
  );
});

// ── #133 slice 3b: the project's declared read-only paths ────────────────────

/**
 * A project directory with a `scripts/` tree, realpath'd.
 *
 * 🛑 `realpathSync`, BECAUSE THE DRIVER EMITS THE CHECKED REAL PATH. `mkdtemp`
 * hands back `/var/folders/…` on macOS and `/var` is a symlink, so an
 * assertion built from the unresolved path compares two spellings of the same
 * directory and fails for a reason that has nothing to do with the mount.
 */
function projectWithScripts(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "chat-mcp-ro-project-")));
  mkdirSync(join(dir, "scripts", "lib"), { recursive: true });

  return dir;
}

test("a declared read-only path is bind-mounted :ro at its path under the work dir", () => {
  setToken("sk-ant-oat-x");
  const dir = projectWithScripts();
  const args = dockerArgsFor({
    cwd: dir,
    supervisorHandle: "claude1",
    readOnlyPaths: ["scripts"],
  });

  assert.ok(
    args.includes(`${dir}/scripts:${CONTAINER_PROJECT_DIR}/scripts:ro`),
  );
});

test("🛑 the :ro mount comes AFTER the read-write project mount, or it is not layered over it", () => {
  setToken("sk-ant-oat-x");
  const dir = projectWithScripts();
  const args = dockerArgsFor({
    cwd: dir,
    supervisorHandle: "claude1",
    readOnlyPaths: ["scripts"],
  });

  // Nested bind precedence is what makes this work at all: the inner mount has
  // to be layered over the wider one. A `:ro` emitted first is a different
  // command with a different result.
  const outer = args.indexOf(`${dir}:${CONTAINER_PROJECT_DIR}`);
  const inner = args.indexOf(
    `${dir}/scripts:${CONTAINER_PROJECT_DIR}/scripts:ro`,
  );

  assert.ok(outer >= 0, "the read-write project mount is missing");
  assert.ok(
    inner > outer,
    `expected the :ro mount at a later index than ${outer}, got ${inner}`,
  );
});

test("🛑 the project mount itself stays READ-WRITE, so the agent can still edit the repo", () => {
  setToken("sk-ant-oat-x");
  const dir = projectWithScripts();
  const args = dockerArgsFor({
    cwd: dir,
    supervisorHandle: "claude1",
    readOnlyPaths: ["scripts"],
  });

  assert.ok(args.includes(`${dir}:${CONTAINER_PROJECT_DIR}`));
  assert.ok(!args.includes(`${dir}:${CONTAINER_PROJECT_DIR}:ro`));
});

test("every declared path gets its own mount, including a nested one", () => {
  setToken("sk-ant-oat-x");
  const dir = projectWithScripts();
  const args = dockerArgsFor({
    cwd: dir,
    supervisorHandle: "claude1",
    readOnlyPaths: ["scripts", "scripts/lib"],
  });

  assert.ok(
    args.includes(`${dir}/scripts:${CONTAINER_PROJECT_DIR}/scripts:ro`),
  );
  assert.ok(
    args.includes(`${dir}/scripts/lib:${CONTAINER_PROJECT_DIR}/scripts/lib:ro`),
  );
});

test("🛑 chat-mcp SHIPS NO DEFAULT: no declared paths means no :ro mount at all", () => {
  setToken("sk-ant-oat-x");
  const dir = projectWithScripts();

  // 🛑 A HANDLE WITH NO REGISTERED MOUNT, SO THE ASSERTION CAN STAY STRONG.
  // This file shares one `CHAT_MCP_HOME` with no reset, so `registerMount`
  // above leaves `claude1` holding an extra mount — which is `:ro` since #231
  // and would be caught here. Narrowing the assertion to the work dir was the
  // first fix and it lost the broader claim: a shipped default mounted
  // anywhere else stopped failing. Raised by claude2 on PR 245.
  for (const opts of [
    { cwd: dir, supervisorHandle: "nodefault" },
    { cwd: dir, supervisorHandle: "nodefault", readOnlyPaths: [] },
  ]) {
    const args = dockerArgsFor(opts);
    // Deriving `scripts/` from a script path is what lee objected to: it would
    // encode one consumer's layout into chat-mcp.
    assert.ok(
      !args.some((arg) => arg.endsWith(":ro")),
      `expected no :ro mount, got ${args.filter((a) => a.endsWith(":ro")).join(", ")}`,
    );
  }
});

test("🛑 a declared path that is a SYMLINK OUT of the project REFUSES the spawn", () => {
  setToken("sk-ant-oat-x");
  const dir = projectWithScripts();
  symlinkSync("/etc", join(dir, "conf"));

  // Mounting it would expose a host directory the project does not own. A
  // LEXICAL check cannot see this, which is the whole reason the driver calls
  // `checkedProjectPath`.
  assert.throws(
    () =>
      dockerArgsFor({
        cwd: dir,
        supervisorHandle: "claude1",
        readOnlyPaths: ["conf"],
      }),
    /outside/,
  );
});

test("🛑 a declared path that is NOT ON DISK refuses, rather than letting docker create an empty one", () => {
  setToken("sk-ant-oat-x");
  const dir = projectWithScripts();

  // docker creates a missing host path as an empty directory, which would MASK
  // the real tree inside the container and read as "the gate script vanished".
  assert.throws(
    () =>
      dockerArgsFor({
        cwd: dir,
        supervisorHandle: "claude1",
        readOnlyPaths: ["nope"],
      }),
    /does not exist/,
  );
});

test("🛑 an ABSOLUTE declared path refuses", () => {
  setToken("sk-ant-oat-x");
  const dir = projectWithScripts();

  assert.throws(
    () =>
      dockerArgsFor({
        cwd: dir,
        supervisorHandle: "claude1",
        readOnlyPaths: ["/etc"],
      }),
    /relative/,
  );
});

test("🛑 a declared path that LEXICALLY escapes the project refuses", () => {
  setToken("sk-ant-oat-x");
  const dir = projectWithScripts();

  assert.throws(
    () =>
      dockerArgsFor({
        cwd: dir,
        supervisorHandle: "claude1",
        readOnlyPaths: ["scripts/../../etc"],
      }),
    /inside the project/,
  );
});

test("🛑 a declared path containing a COLON refuses, rather than emitting a malformed mount spec", () => {
  setToken("sk-ant-oat-x");
  const dir = projectWithScripts();
  mkdirSync(join(dir, "odd:name"));

  // docker's own parser rejects the four-field spec this would build, so the
  // whole spawn dies at `docker run` with `too many colons` instead of here.
  assert.throws(
    () =>
      dockerArgsFor({
        cwd: dir,
        supervisorHandle: "claude1",
        readOnlyPaths: ["odd:name"],
      }),
    /colon/,
  );
});

test("🛑 a declared path that is a SYMLINK INSIDE the project REFUSES, or the real directory stays writable", () => {
  setToken("sk-ant-oat-x");
  const dir = projectWithScripts();
  mkdirSync(join(dir, "real-scripts"));
  symlinkSync("real-scripts", join(dir, "linked"));

  // Mounting `<dir>/real-scripts` at `/work/linked:ro` would leave
  // `/work/real-scripts` writable — the same host directory, under its real
  // name — and the broker resolves `linked/gate.sh` through the symlink too.
  assert.throws(
    () =>
      dockerArgsFor({
        cwd: dir,
        supervisorHandle: "claude1",
        readOnlyPaths: ["linked"],
      }),
    /symlink or sits under one/,
  );
});

test("🛑 a declared path UNDER a symlinked directory refuses for the same reason", () => {
  setToken("sk-ant-oat-x");
  const dir = projectWithScripts();
  mkdirSync(join(dir, "real-scripts", "lib"), { recursive: true });
  symlinkSync("real-scripts", join(dir, "linked"));

  assert.throws(
    () =>
      dockerArgsFor({
        cwd: dir,
        supervisorHandle: "claude1",
        readOnlyPaths: ["linked/lib"],
      }),
    /symlink or sits under one/,
  );
});

test("🛑 EVERY spelling of the project ROOT refuses, not just the bare one", () => {
  setToken("sk-ant-oat-x");
  const dir = projectWithScripts();

  // All three normalise to the root. Mounting it would stop the agent editing
  // the repo it is working in, which is the cost lee explicitly did not accept.
  for (const spelling of [".", "./", "scripts/.."]) {
    assert.throws(
      () =>
        dockerArgsFor({
          cwd: dir,
          supervisorHandle: "claude1",
          readOnlyPaths: [spelling],
        }),
      /project root/,
      `"${spelling}" was accepted`,
    );
  }
});

test("the container side is the NORMALISED path, never the raw declared spelling", () => {
  setToken("sk-ant-oat-x");
  const dir = projectWithScripts();

  for (const spelling of ["scripts/./lib", "scripts//lib", "scripts/lib/"]) {
    const args = dockerArgsFor({
      cwd: dir,
      supervisorHandle: "claude1",
      readOnlyPaths: [spelling],
    });

    assert.ok(
      args.includes(
        `${dir}/scripts/lib:${CONTAINER_PROJECT_DIR}/scripts/lib:ro`,
      ),
      `"${spelling}" emitted ${args.filter((a) => a.endsWith(":ro")).join(", ")}`,
    );
  }
});

test("a project directory reached through a SYMLINK still mounts its real paths", () => {
  setToken("sk-ant-oat-x");
  const real = projectWithScripts();
  const link = join(mkdtempSync(join(tmpdir(), "chat-mcp-ro-link-")), "proj");
  symlinkSync(real, link);

  // `opts.cwd` is whatever the operator registered, and on macOS `mkdtemp`
  // alone hands back a path under the `/var` symlink. The project dir is
  // resolved before the comparison, so this is a mount and not a refusal.
  const args = dockerArgsFor({
    cwd: link,
    supervisorHandle: "claude1",
    readOnlyPaths: ["scripts"],
  });

  assert.ok(
    args.includes(`${real}/scripts:${CONTAINER_PROJECT_DIR}/scripts:ro`),
  );
});

/**
 * 🛑 #183. REFUSED AT SPAWN TOO, not only at registration. `projects.json` is a
 * file on disk, so a registration that predates this guard is still there, and
 * `opts.cwd` reaches the driver from `resolveCwd` rather than only from
 * `registerProject`.
 *
 * The argv is what mounts it, so this is the last place that can say no.
 */
test("🛑 a project dir ABOVE the state directory refuses the spawn argv", () => {
  setToken("sk-ant-oat-x");

  // Positive control: the same call with an ordinary project dir succeeds, so
  // the refusal below is the containment check and not a missing token.
  assert.ok(
    dockerArgsFor({ cwd: PROJECT_DIR, supervisorHandle: "claude1" }).length > 0,
  );

  assert.throws(
    () =>
      dockerArgsFor({
        cwd: dirname(realpathSync(stateDir())),
        supervisorHandle: "claude1",
      }),
    /state directory/,
  );
});

/**
 * 🛑 #183, AND THE EXTRA MOUNTS ARE THE SURFACE A NAME-SCOPED AUDIT MISSES.
 * `mounts.json` is a file, so a key registered before the guard existed is
 * still live, and this loop is the last thing that can refuse it.
 */
test("🛑 an extra mount ABOVE the state directory refuses the spawn argv", () => {
  setToken("sk-ant-oat-x");

  // 🛑 WRITTEN STRAIGHT TO THE FILE, because `registerMount` now refuses it.
  // That IS the case under test: a key registered before the guard existed.
  writeFileSync(
    mountsPath(),
    JSON.stringify({
      agents: { claude8: { evil: dirname(realpathSync(stateDir())) } },
    }),
  );

  assert.throws(
    () => dockerArgsFor({ cwd: PROJECT_DIR, supervisorHandle: "claude8" }),
    /state directory/,
  );
});

const BUS = { url: "http://127.0.0.1:54321/mcp", token: "bus-token-secret" };

function dockerBusPlan() {
  setToken("sk-ant-oat-x");

  return dockerRunPlanFor({
    cwd: PROJECT_DIR,
    supervisorHandle: "claude1",
    bus: BUS,
    grant: {
      handle: "claude1-agent",
      configPath: "/unused/host/path.json",
      tools: [],
    },
  });
}

function busConfig(): Record<string, any> {
  const raw = dockerBusPlan().env[CONTAINER_MCP_CONFIG_ENV];

  assert.ok(raw, `nothing in ${CONTAINER_MCP_CONFIG_ENV}`);

  return JSON.parse(raw) as Record<string, any>;
}

test("🚨 the container config is an HTTP entry, not a command that opens the host database", () => {
  const chat = busConfig().mcpServers.chat;

  assert.equal(chat.type, "http");
  assert.equal(chat.headers.Authorization, `Bearer ${BUS.token}`);
  assert.equal(
    chat.command,
    undefined,
    "still launching a stdio shim inside the container",
  );
});

/**
 * 🛑 THE TRAP IN THIS WHOLE PIECE. `McpHttpListener.url` is the HOST's view,
 * and `127.0.0.1` inside a container is the CONTAINER. Shipping the listener's
 * url verbatim gives the agent a bus that is silently unreachable — it looks
 * configured and connects to nothing.
 */
test("🚨 the config url points at the host, never at the container own loopback", () => {
  const { url } = busConfig().mcpServers.chat;

  assert.equal(url, "http://host.docker.internal:54321/mcp");
  assert.ok(
    !url.includes("127.0.0.1"),
    `the container would dial itself: ${url}`,
  );
});

test("🚨 containerBusUrl keeps the port and the path while moving only the host", () => {
  assert.equal(
    containerBusUrl("http://127.0.0.1:9/mcp"),
    "http://host.docker.internal:9/mcp",
  );
});

test("🚨 the bearer token never appears in the docker argv", () => {
  const { args } = dockerBusPlan();

  for (const arg of args) {
    assert.ok(
      !arg.includes(BUS.token),
      `the bus token reached the argv as ${arg}`,
    );
  }

  assert.ok(
    args.includes(CONTAINER_MCP_CONFIG_ENV),
    "the config is not passed by name",
  );
});

/**
 * The control for the prelude: the CLI's own arguments must survive it as
 * separate argv entries. `sh -c 'script' name args…` puts them in `"$@"`, so
 * nothing is re-quoted or re-split.
 */
test("🚨 the command is wrapped so the config is written INSIDE the container", () => {
  const { args } = dockerBusPlan();
  const sh = args.indexOf("sh");

  assert.ok(sh > 0, "no sh prelude");
  assert.equal(args[sh + 1], "-c");
  assert.ok(
    args[sh + 2]?.includes(containerMcpConfigPath(claudeSpawn)),
    "writes the wrong path",
  );
  assert.ok(args[sh + 2]?.includes('exec "$@"'), "never execs the real CLI");
  assert.equal(
    args[sh + 3],
    "sh",
    "no $0 placeholder, so the first CLI arg is eaten",
  );
  assert.equal(args[sh + 4], "claude");
  assert.ok(
    args.includes("--dangerously-skip-permissions"),
    "CLI flags did not survive",
  );
});

test("🚨 a containerized spawn with no bus endpoint refuses rather than starting blind", () => {
  setToken("sk-ant-oat-x");

  assert.throws(
    () =>
      dockerRunPlanFor({
        cwd: PROJECT_DIR,
        supervisorHandle: "claude1",
        grant: {
          handle: "claude1-agent",
          configPath: "/unused.json",
          tools: [],
        },
      }),
    /bus/i,
  );
});

/**
 * 🚨 `docker rm -f` SIGKILLs this handle's live container. Running it before
 * the plan is validated means a spawn that cannot possibly succeed still takes
 * the running agent down on its way to throwing.
 */
test("🚨 a plan that cannot be built kills nothing", async (t) => {
  setToken("sk-ant-oat-x");

  const { calls } = mockDocker(t);

  const { spawnContainerized } = await import(
    `../../../src/supervise/drivers/containerized.js?order-test=${Date.now()}`
  );

  assert.throws(
    () =>
      spawnContainerized(claudeSpawn, {
        cwd: PROJECT_DIR,
        supervisorHandle: "claude1",
        grant: {
          handle: "claude1-agent",
          configPath: "/unused.json",
          tools: [],
        },
      }),
    /bus/i,
  );

  const removals = calls.filter((argv) => argv[0] === "rm");

  assert.deepEqual(
    removals,
    [],
    `the live container was removed anyway: ${JSON.stringify(removals)}`,
  );
});

/**
 * #214: a containerized agent had no GitHub credential, so it could not file a
 * ticket, open a PR, or push. The token is injected exactly the way the Claude
 * token is — by NAME, so the value never reaches argv.
 */
test("the gh token is injected by NAME via -e, and the value never appears as a bare arg", () => {
  setToken("sk-ant-oat-x");
  setGhToken("ghp-secret-value");

  const { args } = dockerRunPlanFor({
    cwd: PROJECT_DIR,
    supervisorHandle: "claude1",
  });

  assert.ok(args.includes("GH_TOKEN"), "GH_TOKEN is not passed by name");

  for (const arg of args) {
    assert.ok(
      !arg.includes("ghp-secret-value"),
      `the gh token value reached the docker argv as ${arg}`,
    );
  }
});

/**
 * The paired control. An argv that named the var and never carried the value
 * would pass the test above, and `gh` inside the container would still be
 * unauthenticated.
 */
test("the gh token reaches the container through the spawn env instead", () => {
  setToken("sk-ant-oat-x");
  setGhToken("ghp-secret-value");

  const { env } = dockerRunPlanFor({
    cwd: PROJECT_DIR,
    supervisorHandle: "claude1",
  });

  assert.equal(env.GH_TOKEN, "ghp-secret-value");
});

/**
 * 🛑 OPTIONAL, BECAUSE MOST HANDLES NEED NO GITHUB ACCESS. A missing gh token
 * must not fail the spawn the way a missing Claude token does — and it must
 * not pass `-e GH_TOKEN` either. Docker copies a named var from this process's
 * environment, so naming it while the host has none would hand the container
 * an empty `GH_TOKEN`, which `gh` reports as a bad credential rather than as
 * no credential at all.
 */
test("no gh token on file means no -e GH_TOKEN, and the spawn still succeeds", () => {
  setToken("sk-ant-oat-x");
  clearGhToken();

  const { args, env } = dockerRunPlanFor({
    cwd: PROJECT_DIR,
    supervisorHandle: "claude1",
  });

  assert.ok(
    !args.includes("GH_TOKEN"),
    "GH_TOKEN was named with no token on file",
  );
  assert.equal(env.GH_TOKEN, undefined);
});

/**
 * 🛑 ONE STRING, NOT TWO THAT HAPPEN TO MATCH. The storage key IS the injected
 * env var name. Two independent literals would let a rename inject
 * `-e <newname>` for a var `auth.ts` never stores, and the container would get
 * an UNSET `GH_TOKEN` — which `gh` reports as a bad credential rather than as
 * no credential at all. Caught in review before merge; this is the guard.
 */
test("the driver env var name IS the storage key, with no second literal to drift", async () => {
  const { GH_TOKEN_KEY } = await import("../../../src/supervise/auth.js");
  const { CONTAINER_GH_TOKEN_ENV } =
    await import("../../../src/supervise/drivers/containerized.js");

  assert.equal(CONTAINER_GH_TOKEN_ENV, GH_TOKEN_KEY);
});

/**
 * #221 B2/B3/B4. The install step runs on every cold spawn, so its guard and
 * its environment are both load-bearing, and all three failures are silent:
 * a project with no lockfile never starts its agent at all, a changed lockfile
 * runs the suite against the old tree, and dependency lifecycle scripts see
 * every credential the container was given.
 *
 * 🛑 RUN IN A REAL `sh`, NOT MATCHED AGAINST THE STRING. A string assertion
 * cannot tell a guard that skips from a guard that installs, and the `&&`
 * precedence bug already shipped once on a step that read correctly.
 *
 * ⚠️ `shasum -a 256`, NOT `sha256sum`. Both the Debian image and this macOS
 * host carry `shasum`; only the image carries `sha256sum`, so choosing it
 * would put this step beyond the reach of the suite.
 */
interface InstallRig {
  readonly dir: string;
  readonly log: string;
  readonly bin: string;
}

/**
 * A project dir with a fake `npm` first on PATH, recording its argv and the
 * environment it was handed. The recording IS the instrument for B4: a
 * credential that reaches a lifecycle script reaches this log.
 *
 * ⚠️ `npmExit` EXISTS BECAUSE THE DEFAULT CAN ONLY PIN HALF THE `&&` CHAIN. A
 * fake npm that always succeeds leaves the branch where the install FAILS
 * asserted nowhere, and that is the branch which stops the agent starting.
 */
function installRig(lock?: string, npmExit = 0): InstallRig {
  const dir = mkdtempSync(join(tmpdir(), "chat-mcp-install-"));
  const bin = join(dir, "bin");
  const log = join(dir, "npm.log");

  mkdirSync(bin);
  // The volume's mount point exists from the moment docker creates it.
  mkdirSync(join(dir, "node_modules"));
  writeFileSync(
    join(bin, "npm"),
    `#!/bin/sh\necho "NPM $*" >> '${log}'\nenv >> '${log}'\nexit ${npmExit}\n`,
    { mode: 0o755 },
  );
  if (lock !== undefined) writeFileSync(join(dir, "package-lock.json"), lock);

  return { dir, log, bin };
}

/** The install guard's stamp, or undefined when the install never wrote one. */
function stampFor(rig: InstallRig): string | undefined {
  const stamp = join(rig.dir, "node_modules", ".lock-sha");

  return existsSync(stamp) ? readFileSync(stamp, "utf8") : undefined;
}

/**
 * ⚠️ `AGENT_RAN` STANDS FOR "THE STEP EXITED 0", NOT FOR A REAL AGENT START.
 * Since #231 the step runs in its own container and never execs the agent, so
 * the `prelude` wrapper here is the rig's way of making the step's exit code
 * observable. The exit code is what matters: `runDependencyInstall` throws on
 * a non-zero one, and that throw is what stops the agent now.
 */
function runInstallStep(rig: InstallRig, extraEnv: NodeJS.ProcessEnv = {}) {
  const script = prelude([nodeModulesInstallStep(rig.dir)]);

  return spawnSync("sh", ["-c", script, "sh", "echo", "AGENT_RAN"], {
    encoding: "utf8",
    env: { PATH: `${rig.bin}:${process.env.PATH}`, ...extraEnv },
  });
}

/** How many times the fake npm was invoked, 0 when it never was. */
function npmCalls(rig: InstallRig): number {
  if (!existsSync(rig.log)) return 0;

  return readFileSync(rig.log, "utf8")
    .split("\n")
    .filter((l) => l.startsWith("NPM ")).length;
}

/**
 * 🛑 B2. Wrapping the ungranted branch in `sh -c` made the install
 * unconditional, so a project with no `package-lock.json` — a Python repo, say
 * — fails the install, and the `&&` chain means `exec "$@"` is never reached.
 * The agent does not start at all. Every dir configured on 2026-11-13 had a
 * lockfile, so this was latent, one config edit from live.
 */
test("🛑 a project with no lockfile skips the install and STILL starts its agent", () => {
  const rig = installRig();
  const ran = runInstallStep(rig);

  assert.equal(npmCalls(rig), 0, "npm ci ran with no lockfile to install from");
  assert.equal(
    ran.stdout.trim(),
    "AGENT_RAN",
    `the agent never started; stderr: ${ran.stderr}`,
  );
});

/**
 * ⚠️ THE PAIRED CONTROL, AND IT IS THE ONE THAT CATCHES A GUARD THAT NEVER
 * INSTALLS. A step that skipped unconditionally would pass the test above and
 * leave the volume empty, which is the false-green suite this ticket exists
 * to stop.
 */
test("⚠️ control — a project WITH a lockfile does install", () => {
  const rig = installRig('{"lockfileVersion":3}');
  const ran = runInstallStep(rig);

  assert.equal(npmCalls(rig), 1, "npm ci did not run despite a lockfile");
  assert.equal(ran.stdout.trim(), "AGENT_RAN");
});

/**
 * 🛑 B3. The old guard was npm's own marker, so once the volume was populated
 * the install never ran again. After the host's `package-lock.json` changes,
 * the container runs the suite against the OLD dependency tree and reports a
 * pass — the exact false green the `&&` chain exists to prevent.
 */
test("🛑 a CHANGED lockfile reinstalls, because the volume outlives the --rm", () => {
  const rig = installRig('{"lockfileVersion":3,"v":1}');

  runInstallStep(rig);
  writeFileSync(
    join(rig.dir, "package-lock.json"),
    '{"lockfileVersion":3,"v":2}',
  );
  const ran = runInstallStep(rig);

  assert.equal(
    npmCalls(rig),
    2,
    "the second spawn reused dependencies from the old lockfile",
  );
  assert.equal(ran.stdout.trim(), "AGENT_RAN");
});

/**
 * ⚠️ THE PAIRED CONTROL. A guard that reinstalled every spawn would pass the
 * test above and add a full `npm ci` to every warm start.
 */
test("⚠️ control — an UNCHANGED lockfile does not reinstall", () => {
  const rig = installRig('{"lockfileVersion":3}');

  runInstallStep(rig);
  const ran = runInstallStep(rig);

  assert.equal(
    npmCalls(rig),
    1,
    "the install reran against an unchanged lockfile",
  );
  assert.equal(ran.stdout.trim(), "AGENT_RAN");
});

/**
 * 🚨 B4 IS CLOSED BY A CONTAINER NOW, NOT BY A SCRUB, SO ITS TWO TESTS ARE
 * GONE FROM HERE. They asserted that `env -u` removed three names from the
 * `npm ci` child, which was true and was never the boundary — docker hands the
 * credentials to PID 1, so a lifecycle script read them from
 * `/proc/1/environ` regardless. #231 moved the install into a container that
 * is handed none, and the replacements live beside `dockerInstallPlan`:
 * "the install container is handed NO credential at all" and its control.
 */

/**
 * 🚨 B5. `npm ci` ALWAYS RUNS THIS PROJECT'S OWN `prepare`, which is
 * `npm run build`. So the install did not only install — it ran `tsc` against
 * the host checkout, which `/work` binds read-write.
 *
 * Two consequences, and the second is the one that stops an agent:
 *
 * 1. It WRITES THE HOST TREE. Measured in a container on a clean `git archive`
 *    with a fresh volume: `dist/` went 0 files to 14. `dist/` is what the host
 *    supervisor runs from, and `imageNeedsBuild()` is built around who last
 *    rebuilt it.
 * 2. A FAILING `tsc` MEANS NO AGENT STARTS. `npm ci` exits 1, the `&&` chain
 *    holds, `exec "$@"` is never reached — on any branch carrying a type
 *    error, which is the ordinary mid-work state and exactly when someone
 *    spawns an agent to help fix it.
 *
 * ⚠️ `--ignore-scripts`, AND THE RECORDED REASON FOR REJECTING IT WAS WRONG.
 * #221 argued esbuild's postinstall must run. It need not: `@esbuild/<platform>`
 * ships its binary as an optional dependency. Measured in-container with a
 * fresh volume — `@esbuild/linux-arm64` present, `tsx` loading, a real suite
 * file passing 4/4, and 0 files written to the tree.
 *
 * 🛑 WHAT THIS ASSERTS IS THE ARGV, BECAUSE THE RIG'S npm IS A FAKE. A fake
 * cannot honour the flag, so the consequence above is measured in a real
 * container and only the flag's PRESENCE is pinned here. It is still the guard
 * that matters: the flag is what a future edit would drop.
 *
 * ⚠️ IT DOES NOT NARROW #231. The credentials still reach PID 1, so a
 * lifecycle script that did run would recover them from `/proc/1/environ`.
 */
test("🚨 the install cannot run a lifecycle script, including this project's own prepare", () => {
  const rig = installRig('{"lockfileVersion":3}');
  const ran = runInstallStep(rig);

  assert.match(
    readFileSync(rig.log, "utf8"),
    /^NPM .*--ignore-scripts/m,
    "npm ci may run this project's prepare, so the install writes dist/ in the host tree",
  );
  assert.equal(ran.stdout.trim(), "AGENT_RAN");
});

/**
 * 🛑 THE FAILING-INSTALL BRANCH, AND IT WAS ASSERTED NOWHERE. The rig's npm
 * always exited 0, so the load-bearing half of `npm ci && printf … > stamp`
 * had no test at all — neither the `&&` nor the `exec` it gates.
 *
 * Both halves are pinned at once, because each alone is passable by a wrong
 * step:
 *
 * - NO AGENT STARTS. An install that half-finished and then started the agent
 *   anyway produces the false-green suite this ticket exists to stop.
 * - NO STAMP IS WRITTEN, so the next spawn RETRIES. A stamp written beside a
 *   failed install makes every later spawn skip the install and run against an
 *   empty volume, which is worse than the failure it recorded.
 */
test("🛑 a FAILING install starts no agent and leaves no stamp, so the next spawn retries", () => {
  const rig = installRig('{"lockfileVersion":3}', 1);
  const ran = runInstallStep(rig);

  assert.equal(
    npmCalls(rig),
    1,
    "the install never ran, so this proves nothing about failing",
  );
  assert.equal(
    ran.stdout.trim(),
    "",
    `the agent started on a failed install; stderr: ${ran.stderr}`,
  );
  assert.equal(
    stampFor(rig),
    undefined,
    "a failed install stamped the lockfile as installed",
  );
  assert.notEqual(
    ran.status,
    0,
    "the prelude reported success after a failed install",
  );
});

/**
 * ⚠️ THE PAIRED CONTROL, AND IT IS WHAT SEPARATES THE `&&` FROM A STEP THAT
 * NEVER STAMPS. A step that dropped the `printf` entirely would pass the test
 * above and reinstall on every single spawn.
 */
test("⚠️ control — a SUCCEEDING install writes the stamp and starts the agent", () => {
  const rig = installRig('{"lockfileVersion":3}');
  const ran = runInstallStep(rig);

  assert.match(
    String(stampFor(rig)),
    /^[0-9a-f]{64}$/,
    "a successful install wrote no stamp",
  );
  assert.equal(ran.stdout.trim(), "AGENT_RAN");
  assert.equal(ran.status, 0);
});

/**
 * #234. The guard hashes the lockfile with `shasum`, which reaches the image
 * only because `perl` is named in the apt list. Drop `perl` and the hash comes
 * back empty, so the guard installs 142 packages on every single warm spawn —
 * and nothing fails, so nothing says so.
 *
 * 🛑 THE CHECK REPORTS AND LETS THE INSTALL PROCEED. lee's ruling on #234: the
 * prelude chains on `&&` and ends in `exec "$@"`, so a bare `command -v shasum`
 * exits non-zero on a `perl`-less image and NO agent starts at all. A missing
 * `shasum` is a performance defect, not a reason to refuse a spawn.
 *
 * 🛑 STDERR, NOT STDOUT, AND THAT IS THE WHOLE REASON #229's STDERR WIRING
 * CAME FIRST. `child.ts` drops a non-JSON stdout line on purpose, so a warning
 * written there vanishes as quietly as the defect it reports. With both
 * channels dead this check would have written into nothing in either arm — a
 * guard that always fails open.
 *
 * ⚠️ A SEALED PATH, BECAUSE `shasum` MUST BE GENUINELY ABSENT. `installRig`
 * prepends its fake npm to the real PATH, where the host's `/usr/bin/shasum`
 * is always reachable. So the rig below rebuilds PATH as one directory holding
 * only the externals the step needs, and `shasum` is in it or it is not.
 */
type ShasumState = "absent" | "working" | "broken";

function sealedBin(rig: InstallRig, shasum: ShasumState): string {
  const sealed = join(rig.dir, `sealed-${shasum}`);

  // Built once per rig, because a test may run the step twice.
  if (existsSync(sealed)) return sealed;
  mkdirSync(sealed);
  // ⚠️ A SHIM, NOT A SYMLINK. macOS `shasum` is a perl script, and perl refuses
  // to run itself through a symlink — "can't run .../shasum. Try the
  // alternative(s)". The symlinked rig reported an unreadable hash WITH shasum
  // present, which is the control's failure dressed as the defect.
  //
  // `echo` is here because `exec "$@"` needs the EXTERNAL one — exec never
  // reaches a builtin, so a sealed PATH without it starts no agent at all.
  //
  // 🛑 RESOLVED BY SEARCHING THE SYSTEM DIRS, NOT BY `command -v`. `echo` is a
  // shell builtin, so `command -v echo` answers `echo` — not a path. Shimmed
  // from that answer, `exec 'echo'` re-resolves through this very directory and
  // execs the shim again, forever. It spawns processes until something dies.
  for (const tool of [
    "cut",
    "cat",
    "env",
    "echo",
    "npm",
    ...(shasum === "working" ? ["shasum"] : []),
  ]) {
    const found =
      tool === "npm"
        ? join(rig.bin, "npm")
        : ["/bin", "/usr/bin"]
            .map((d) => join(d, tool))
            .find((c) => existsSync(c));

    assert.ok(
      found,
      `this host has no ${tool}, so the rig cannot run the step at all`,
    );
    writeFileSync(join(sealed, tool), `#!/bin/sh\nexec '${found}' "$@"\n`, {
      mode: 0o755,
    });
  }

  // 🛑 RESOLVES, AND CANNOT RUN. This is what dropping `perl` really leaves
  // behind, and it is the arm `command -v shasum` passed in silence.
  if (shasum === "broken") {
    writeFileSync(join(sealed, "shasum"), "#!/nonexistent/perl\n", {
      mode: 0o755,
    });
  }

  return sealed;
}

function runInstallStepSealed(rig: InstallRig, shasum: ShasumState) {
  const script = prelude([nodeModulesInstallStep(rig.dir)]);

  return spawnSync("/bin/sh", ["-c", script, "sh", "echo", "AGENT_RAN"], {
    encoding: "utf8",
    env: { PATH: sealedBin(rig, shasum) },
  });
}

test("🛑 a missing shasum SAYS SO on stderr, and the agent still starts", () => {
  const rig = installRig('{"lockfileVersion":3}');
  const ran = runInstallStepSealed(rig, "absent");

  assert.ok(
    ran.stderr.includes(NO_LOCK_HASH_WARNING),
    `a perl-less image reinstalls every spawn with nothing saying why; stderr: ${ran.stderr}`,
  );
  assert.equal(
    ran.stdout.trim(),
    "AGENT_RAN",
    "the check refused the spawn instead of reporting",
  );
  assert.equal(
    ran.status,
    0,
    "the check broke the && chain, so no agent starts",
  );
  assert.equal(
    npmCalls(rig),
    1,
    "the check stopped the install it is only meant to report on",
  );
});

/**
 * 🔴 THE ARM THE FIRST CUT PASSED IN SILENCE, found by claude2 on PR 241.
 *
 * That cut hung the warning off `command -v shasum`, which tests whether the
 * name RESOLVES. The defect #234 reports is an EMPTY HASH. A `shasum` that
 * resolves and cannot execute — a perl script with no perl, which is what
 * dropping `perl` actually leaves — passes `command -v`, hashes to nothing,
 * reinstalls 142 packages every spawn and says NOTHING.
 *
 * 🛑 SO THE WARNING HANGS OFF THE EMPTINESS ITSELF, not off one cause of it.
 * Measured in a real `node:22-slim` container before the fix: `command -v`
 * answered `/work/bin/shasum`, the install ran, and a grep for the warning
 * counted 0.
 *
 * ⚠️ `shasum`'s own `not found` on stderr is NOT what this asserts. That line
 * names the cause and the shell writes it either way. This asserts the line
 * that names the CONSEQUENCE, which is the one nobody else writes.
 */
test("🔴 a shasum that RESOLVES but cannot run still says so, because the hash is empty", () => {
  const rig = installRig('{"lockfileVersion":3}');
  const ran = runInstallStepSealed(rig, "broken");

  assert.ok(
    ran.stderr.includes(NO_LOCK_HASH_WARNING),
    `a resolvable but unrunnable shasum reinstalls in silence; stderr: ${ran.stderr}`,
  );
  assert.equal(
    npmCalls(rig),
    1,
    "the empty hash did not reach the install branch",
  );
  assert.equal(
    ran.stdout.trim(),
    "AGENT_RAN",
    "a broken shasum stopped the agent starting",
  );
});

/**
 * ⚠️ THE PAIRED CONTROL, AND IT IS THE ONE THAT CATCHES A CHECK THAT ALWAYS
 * WARNS. A step that printed the line unconditionally would pass the test
 * above and put a permanent false warning in front of every operator.
 */
test("⚠️ control — shasum PRESENT warns about nothing and stamps the lockfile", () => {
  const rig = installRig('{"lockfileVersion":3}');
  const ran = runInstallStepSealed(rig, "working");

  assert.ok(
    !ran.stderr.includes(NO_LOCK_HASH_WARNING),
    `warned about a shasum that resolves; stderr: ${ran.stderr}`,
  );
  assert.match(
    String(stampFor(rig)),
    /^[0-9a-f]{64}$/,
    "the hash was unreadable WITH shasum",
  );
  assert.equal(ran.stdout.trim(), "AGENT_RAN");
});

/**
 * 🛑 THE REPORTED DEFECT ITSELF, ASSERTED RATHER THAN DESCRIBED. The warning
 * is worth nothing if a later edit "fixes" the reinstall by skipping instead —
 * that is the false green the unreadable-hash branch exists to avoid. So the
 * cheap failure stays the cheap failure, and the check only names it.
 */
/**
 * 🛑 THE WARNING REACHES THE SCRIPT INSIDE SINGLE QUOTES, so an apostrophe in
 * it closes the quote and the prelude becomes a different program. The step
 * then fails, the `&&` chain holds, and NO AGENT STARTS — a wording change
 * taking down every spawn. The guard is here because nothing else would catch
 * it until a container refused to boot.
 */
test("🛑 the warning carries no single quote, which would break the prelude it rides in", () => {
  assert.ok(
    !NO_LOCK_HASH_WARNING.includes("'"),
    `an apostrophe closes the shell quote: ${NO_LOCK_HASH_WARNING}`,
  );
});

test("🛑 a missing shasum keeps REINSTALLING, which is the designed cheap failure", () => {
  const rig = installRig('{"lockfileVersion":3}');

  runInstallStepSealed(rig, "absent");
  const ran = runInstallStepSealed(rig, "absent");

  assert.equal(
    npmCalls(rig),
    2,
    "an unreadable hash skipped the install and ran on an empty tree",
  );
  assert.equal(ran.stdout.trim(), "AGENT_RAN");
});

/**
 * 🚨 #231. THE INSTALL USED TO RUN INSIDE THE AGENT CONTAINER, which docker
 * hands every credential as PID 1 — so a dependency's lifecycle script read
 * the bus bearer token, `GH_TOKEN` and the Claude OAuth token out of
 * `/proc/1/environ`. Both routes were MEASURED in a built image, not reasoned.
 * The lockfile that picks which packages install comes from the mounted
 * project tree, so the tree chose the code that read them.
 *
 * ⚠️ DERIVED FROM `containerCredentialEnvVars`, NOT FROM A LIST OF THREE. A
 * fourth credential added to the agent plan must not become a silent exception
 * here, which is the drift that made the old `env -u` scrub rot.
 */
test("🚨 the install container is handed NO credential at all", (t) => {
  setToken("sk-ant-oat-x");
  setGhToken("ghp-x");

  // 🛑 SET IN `process.env` FIRST, OR THE ENVIRONMENT HALF IS VACUOUS. The
  // first cut of this asserted the three names were absent from the plan's
  // `env` while the TEST PROCESS had never held them — `setToken` writes to
  // disk, not to the environment — so deleting the implementation's whole
  // removal loop left this green. Caught by the negative control.
  const planted = `planted-${Date.now()}`;
  const credentials = containerCredentialEnvVars(claudeSpawn);

  for (const name of credentials) process.env[name] = planted;
  t.after(() => {
    for (const name of credentials) delete process.env[name];
  });

  const { args, env } = dockerInstallPlan(claudeSpawn, {
    cwd: PROJECT_DIR,
    supervisorHandle: "claude1",
    bus: BUS,
    grant: { handle: "claude1-agent", configPath: "/unused.json", tools: [] },
  });
  const named = args.filter((_, i) => args[i - 1] === "-e");

  assert.deepEqual(named, [], `the install plan names ${named.join(", ")}`);

  // 🛑 THE CLIENT ENVIRONMENT TOO, BECAUSE `-e NAME` WITH NO `=` COPIES FROM
  // IT. Guarding only the argv leaves a later stray `-e` one character from
  // re-opening this, and the plan would again carry a credential it means to
  // withhold.
  for (const name of credentials) {
    assert.equal(
      env[name],
      undefined,
      `${name} is still in the install client's environment`,
    );
  }

  // ⚠️ THE CONTROL FOR THE PLANT ITSELF. If `process.env` never took the
  // value, the loop above asserts absence of something that was never there.
  assert.equal(
    process.env[credentials[0]],
    planted,
    "the plant did not land, so the assertions above are vacuous",
  );

  clearGhToken();
});

/**
 * ⚠️ THE OTHER HALF OF THE CREDENTIAL TEST, AND IT IS WHAT SEPARATES DELETING
 * THREE NAMES FROM HANDING THE INSTALL AN EMPTY ENVIRONMENT. `env -i` would
 * satisfy "names no credential" perfectly and break the install, which needs
 * `PATH` to find npm at all and `HOME` for npm's cache.
 *
 * 🛑 ASSERTED ON THE PLAN, NOT IN A RIG. `dockerInstallPlan` builds its `env`
 * by DELETING from `process.env`, so a wrong implementation here is a wholesale
 * replacement — which no shell-level rig can see, because the rig supplies its
 * own environment.
 */
test("⚠️ control — the install container keeps the ordinary environment it needs", () => {
  setToken("sk-ant-oat-x");

  const { env } = dockerInstallPlan(claudeSpawn, {
    cwd: PROJECT_DIR,
    supervisorHandle: "claude1",
  });

  assert.equal(
    env.PATH,
    process.env.PATH,
    "the install lost PATH, so npm itself is unreachable",
  );
  assert.equal(
    env.HOME,
    process.env.HOME,
    "the install lost HOME, where npm caches",
  );
});

/**
 * ⚠️ THE CONTROL FOR THE CREDENTIAL TEST, AND IT IS THE ONE THAT CATCHES AN
 * EMPTY PLAN. A `dockerInstallPlan` that returned no argv at all would satisfy
 * "names no credential" perfectly and install nothing, which is a volume that
 * stays empty and a suite that cannot run.
 */
test("⚠️ control — the install container really does install, into the shared volume", () => {
  setToken("sk-ant-oat-x");

  const { args } = dockerInstallPlan(claudeSpawn, {
    cwd: PROJECT_DIR,
    supervisorHandle: "claude1",
  });
  const script = args.find((a) => a.includes("npm ci"));

  assert.ok(script, `no install script in ${args.join(" ")}`);
  assert.ok(
    args.includes(`${PROJECT_DIR}:${CONTAINER_PROJECT_DIR}`),
    "the install cannot see the project tree it installs from",
  );
  assert.ok(
    args.includes(
      `${nodeModulesVolumeFor("claude1", PROJECT_DIR)}:${CONTAINER_PROJECT_DIR}/node_modules`,
    ),
    "the install writes somewhere the agent container will not read",
  );
});

/**
 * 🛑 lee's RULING, 2026-11-14 on #231: *"drop them"*. The only extra mount
 * configured in practice is `local-context -> ~/context`, and it was attached
 * read-write — so a dependency's install script could write to the whole
 * local-context store. The install needs the project tree and the volume to do
 * its job, and nothing else.
 *
 * ⚠️ ASSERTED AS AN EXACT MOUNT SET, not as the absence of one key. A future
 * extra mount added to the agent plan would otherwise reach this container
 * with no test failing.
 */
test("🛑 the install container gets EXACTLY two mounts, so a hostile install cannot reach a host dir", (t) => {
  setToken("sk-ant-oat-x");
  const home = mkdtempSync(join(tmpdir(), "chat-mcp-install-mounts-"));
  const extra = mkdtempSync(join(tmpdir(), "chat-mcp-install-extra-"));

  t.after(() => undefined);
  registerMount("claude1", "local-context", extra);

  const { args } = dockerInstallPlan(claudeSpawn, {
    cwd: PROJECT_DIR,
    supervisorHandle: "claude1",
  });
  const mounts = args.filter((_, i) => args[i - 1] === "-v");

  assert.deepEqual(
    mounts,
    [
      `${PROJECT_DIR}:${CONTAINER_PROJECT_DIR}`,
      `${nodeModulesVolumeFor("claude1", PROJECT_DIR)}:${CONTAINER_PROJECT_DIR}/node_modules`,
    ],
    `the install container sees more than the project tree and its volume: ${mounts.join(", ")}`,
  );
  assert.ok(
    !mounts.some((m) => m.startsWith(`${extra}:`)),
    "a configured extra mount reached the install container",
  );
  assert.ok(home);
});

/**
 * 🛑 THE OTHER HALF OF THE MOVE, AND WITHOUT IT NOTHING IS FIXED. A plan that
 * builds a credential-free install container and ALSO leaves `npm ci` in the
 * agent container's prelude has added a container and closed nothing.
 */
test("🚨 the AGENT container's prelude no longer installs anything", () => {
  setToken("sk-ant-oat-x");
  setGhToken("ghp-x");

  const args = dockerArgsFor({
    cwd: PROJECT_DIR,
    supervisorHandle: "claude1",
    bus: BUS,
    grant: { handle: "claude1-agent", configPath: "/unused.json", tools: [] },
  });

  assert.ok(
    !args.some((a) => a.includes("npm ci")),
    "the agent container still runs npm ci beside the credentials",
  );

  clearGhToken();
});

/**
 * ⚠️ THE SCRUB IS DELETED, NOT MERELY BYPASSED. Left in, it reads as a
 * boundary — which is the claim #231 retracted — and it is a textual promise
 * about an environment this container does not have.
 *
 * 🛑 ASSERTED ON THE INSTALL PLAN'S SCRIPT, AND THE FIRST CUT OF THIS GOT IT
 * WRONG. It sat on the AGENT argv, where the install step no longer appears at
 * all, so it was vacuous: re-adding a real `env -u` to the step left it green.
 * Caught by the negative control, not by reading the diff.
 */
test("🚨 the install step names no credential, because its container has none", () => {
  setToken("sk-ant-oat-x");

  const { args } = dockerInstallPlan(claudeSpawn, {
    cwd: PROJECT_DIR,
    supervisorHandle: "claude1",
  });
  const step = args.find((a) => a.includes("npm ci"));

  assert.ok(step, `no install step in ${args.join(" ")}`);
  assert.ok(
    !step.includes("env -u"),
    `the env -u scrub survived in the step: ${step}`,
  );
  for (const name of containerCredentialEnvVars(claudeSpawn)) {
    assert.ok(!step.includes(name), `the step still names ${name}`);
  }
});

/**
 * ⚠️ THE CONTROL. An agent plan that lost its whole prelude would pass the
 * test above and start a granted agent with no MCP config — an agent that
 * answers nothing, with no error.
 */
test("⚠️ control — the agent container still writes its MCP config", () => {
  setToken("sk-ant-oat-x");

  const args = dockerArgsFor({
    cwd: PROJECT_DIR,
    supervisorHandle: "claude1",
    bus: BUS,
    grant: { handle: "claude1-agent", configPath: "/unused.json", tools: [] },
  });
  const script = args.find((a) => a.includes("umask 077"));

  assert.ok(script, `no MCP config step in ${args.join(" ")}`);
  assert.ok(
    script.includes('exec "$@"'),
    "the prelude no longer execs the agent",
  );
});

/**
 * 🛑 ORDERING IS THE WHOLE POINT. The agent container reads `node_modules`
 * from the named volume, so an install that runs after it — or concurrently —
 * starts the suite against an empty or half-written tree. That is the false
 * green the old `&&` chain existed to prevent, and splitting the containers
 * must not lose it.
 */
test("🛑 the install container runs to completion BEFORE the agent container starts", async (t) => {
  setToken("sk-ant-oat-x");
  const { calls } = mockDocker(t);

  const { spawnContainerized } = await import(
    `../../../src/supervise/drivers/containerized.js?install-order=${Date.now()}`
  );
  spawnContainerized(claudeSpawn, {
    cwd: PROJECT_DIR,
    supervisorHandle: "claude1",
  });

  const installAt = calls.findIndex((argv) =>
    argv.some((a) => a.includes("npm ci")),
  );
  const agentAt = calls.findIndex(
    (argv) => argv.includes("chat-mcp-claude1") && argv[0] === "run",
  );

  assert.ok(installAt >= 0, "no install container was run");
  assert.ok(agentAt >= 0, "no agent container was run");
  assert.ok(
    installAt < agentAt,
    `the agent started first: install at ${installAt}, agent at ${agentAt}`,
  );
});

/**
 * 🛑 A FAILED INSTALL MUST MEAN NO AGENT, which is what the prelude's `&&`
 * guaranteed while both lived in one container. An agent that starts on a
 * half-written volume produces a review claiming a green suite it never ran.
 */
test("🚨 an install that fails kills nothing and starts no agent, and the error names the cause", async (t) => {
  setToken("sk-ant-oat-x");
  const calls: string[][] = [];
  let installStdio: unknown[] | undefined;

  t.mock.module("node:child_process", {
    namedExports: {
      spawn: (_cmd: string, args: string[]) => {
        calls.push(["spawn", ...args]);
        return { on: () => undefined, unref: () => undefined };
      },
      execFileSync: (
        _cmd: string,
        args: string[],
        o?: { stdio?: unknown[]; env?: NodeJS.ProcessEnv },
      ) => {
        calls.push(args);
        // Only the install fails. The `rm -f` is left working on purpose, so
        // that its ABSENCE below is the implementation's choice and not the
        // mock's.
        if (args.some((a) => a.includes("npm ci"))) {
          installStdio = o?.stdio;
          throw new Error("npm ci exited 1");
        }
        return Buffer.from("");
      },
    },
  });

  const { spawnContainerized } = await import(
    `../../../src/supervise/drivers/containerized.js?install-fail=${Date.now()}`
  );

  let thrown: unknown;

  assert.throws(() => {
    try {
      spawnContainerized(claudeSpawn, {
        cwd: PROJECT_DIR,
        supervisorHandle: "claude1",
      });
    } catch (err) {
      thrown = err;
      throw err;
    }
  }, /install/i);

  const spawned = calls.filter((argv) => argv[0] === "spawn");

  assert.deepEqual(
    spawned,
    [],
    `an agent was spawned despite a failed install: ${JSON.stringify(spawned)}`,
  );

  // 🛑 THE `cause` IS ASSERTED BECAUSE A COMMENT CLAIMS IT. `runDependencyInstall`
  // replaces `execFileSync`'s own "Command failed: docker run …" with a sentence
  // that names the dependencies, and the original must still be reachable or
  // the real exit reason is gone. Raised by `dry-solid-reviewer` on PR 259.
  assert.match(
    String((thrown as Error).message),
    /the dependency install container failed/,
    "the thrown message does not name what failed",
  );
  assert.match(
    String(((thrown as Error).cause as Error)?.message),
    /npm ci exited 1/,
    "the underlying failure is unreachable from the wrapper",
  );

  // 🚨 THE INVARIANT `dockerRunPlan` IS ALREADY HELD TO, AND THE FIRST CUT OF
  // THIS PR BROKE IT. `docker rm -f` SIGKILLs the container this handle is
  // replacing, so a throw ordered after it means a spawn that could never
  // succeed — a registry 503, say — destroys the agent on its way out.
  //
  // Its sibling is "a plan that cannot be built kills nothing", which covers
  // the other throw source. Raised by claude1 on PR 259; my own test asserted
  // only that nothing SPAWNED, which the broken order satisfied.
  const removals = calls.filter((argv) => argv[0] === "rm");

  assert.deepEqual(
    removals,
    [],
    `a failed install removed the live container anyway: ${JSON.stringify(removals)}`,
  );

  // 🛑 STDERR INHERITED, AND A COMMENT CLAIMS THIS TOO. `NO_LOCK_HASH_WARNING`
  // is written to the install's stderr, so piping it swallows #234's whole
  // symptom. stdout is dropped on purpose — npm is chatty.
  assert.deepEqual(
    installStdio,
    ["ignore", "ignore", "inherit"],
    "the install's stderr is not inherited, so the no-hash warning vanishes",
  );
});

/**
 * 🚨 `--driver docker-claude` SELECTS A CONTAINER WITHOUT BUILDING ONE, and
 * that is a live path rather than a hypothetical.
 *
 * ```
 * ALIASES["docker-claude"].mode === "docker"   -> isContainerSpawn is true
 * src/index.ts  if (o.container) { … buildImage() }   <- the flag skips this
 * ```
 *
 * 🛑 BEFORE #231 THIS FAILED ASYNCHRONOUSLY. `spawn()` reported a missing image
 * on the child, so the supervisor came up and the agent failed later. The
 * install is `execFileSync`, so it now fails synchronously and the supervisor
 * refuses to start — which lee ruled is correct, so only the SENTENCE needed
 * fixing.
 *
 * ⚠️ IT MUST NOT READ AS A DEPENDENCY FAILURE. "the dependency install
 * container failed" sends the operator to npm when the fix is one flag. Raised
 * by claude1 after I claimed the image was always already built.
 */
test("🚨 a missing image refuses by NAME, not as a dependency failure", async (t) => {
  setToken("sk-ant-oat-x");

  t.mock.module("node:child_process", {
    namedExports: {
      spawn: () => ({ on: () => undefined, unref: () => undefined }),
      execFileSync: (_cmd: string, args: string[]) => {
        if (args[0] === "image" && args[1] === "inspect") {
          throw new Error("No such image");
        }
        return Buffer.from("");
      },
    },
  });

  const { runDependencyInstall } = await import(
    `../../../src/supervise/drivers/containerized.js?no-image=${Date.now()}`
  );

  assert.throws(
    () =>
      runDependencyInstall(claudeSpawn, {
        cwd: PROJECT_DIR,
        supervisorHandle: "claude1",
      }),
    (err: Error) => {
      assert.match(
        err.message,
        new RegExp(claudeSpawn.image.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        "the refusal does not name the image that is missing",
      );
      assert.match(
        err.message,
        /--container/,
        "the refusal does not name the flag that builds it",
      );
      // 🛑 THE NEGATIVE HALF, AND IT IS THE WHOLE POINT. The wrapper's own
      // sentence is the wrong diagnosis for this cause.
      assert.doesNotMatch(
        err.message,
        /dependency install container failed/,
        "a missing image still reports as a dependency failure",
      );

      return true;
    },
  );
});
