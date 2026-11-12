import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn as realSpawn } from 'node:child_process';

process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), 'chat-mcp-docker-driver-'));

const { setToken } = await import('../../../src/supervise/auth.js');
const { stateDir } = await import('../../../src/util/paths.js');
const { registerMount, mountsPath } = await import('../../../src/supervise/mounts.js');
const { claudeSpawn } = await import('../../../src/adapters/claude-spawn.js');
const {
  dockerArgsForVendor,
  CONTAINER_PROJECT_DIR,
  containerStateDir,
  containerPathFor,
} = await import('../../../src/supervise/drivers/containerized.js');

const PROJECT_DIR = mkdtempSync(join(tmpdir(), 'chat-mcp-docker-project-'));

function dockerArgsFor(opts: Parameters<typeof dockerArgsForVendor>[1]) {
  return dockerArgsForVendor(claudeSpawn, opts);
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

  t.mock.module('node:child_process', {
    namedExports: {
      spawn: (_cmd: string, args: string[]) => {
        calls.push(args);
        if (args[0] === 'stop') {
          stopInvocations.push(args);
          // `dockerStopFor` attaches an 'error' listener and calls `unref()`,
          // so the stub has to answer both or the code under test throws.
          return { on: () => undefined, unref: () => undefined };
        }
        // A real, controllable stand-in for the `docker run` CLI process:
        // long-lived with piped stdio, since spawnContainerized reads
        // child.stdout directly.
        fakeDockerRun = realSpawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
        return fakeDockerRun;
      },
      // The pre-run `docker rm -f` is the one call that must still be
      // synchronous — the name has to be free before `docker run`.
      execFileSync: (_cmd: string, args: string[]) => {
        calls.push(args);
        return Buffer.from('');
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

test('with no token on file, building argv throws naming the fix', () => {
  assert.throws(
    () => dockerArgsFor({ cwd: PROJECT_DIR, supervisorHandle: 'claude1' }),
    /chat-mcp auth set-token/,
  );
});

test('the project dir is bind-mounted to the fixed in-container work dir', () => {
  setToken('sk-ant-oat-x');
  const args = dockerArgsFor({ cwd: PROJECT_DIR, supervisorHandle: 'claude1' });
  assert.ok(args.includes(`${PROJECT_DIR}:${CONTAINER_PROJECT_DIR}`));
});

test('the chat-mcp state dir is bind-mounted so the bus is reachable in-container', async () => {
  const { stateDir } = await import('../../../src/util/paths.js');
  setToken('sk-ant-oat-x');
  const args = dockerArgsFor({ cwd: PROJECT_DIR, supervisorHandle: 'claude1' });
  assert.ok(args.includes(`${stateDir()}:${containerStateDir(claudeSpawn)}`));
});

test('a registered extra mount appears at /mnt/<key>', () => {
  const extraDir = mkdtempSync(join(tmpdir(), 'chat-mcp-docker-extra-'));
  setToken('sk-ant-oat-x');
  registerMount('claude1', 'local-context', extraDir);
  const args = dockerArgsFor({ cwd: PROJECT_DIR, supervisorHandle: 'claude1' });
  assert.ok(args.includes(`${extraDir}:${containerPathFor('local-context')}`));
});

test('the token is injected by NAME via -e, and the value never appears as a bare arg', () => {
  setToken('sk-ant-oat-secret-value');
  const args = dockerArgsFor({ cwd: PROJECT_DIR, supervisorHandle: 'claude1' });
  assert.ok(args.includes('CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat-secret-value'));
});

test('the child command always carries --allow-dangerously-skip-permissions, never --permission-mode', () => {
  setToken('sk-ant-oat-x');
  const args = dockerArgsFor({ cwd: PROJECT_DIR, supervisorHandle: 'claude1' });
  assert.ok(args.includes('--allow-dangerously-skip-permissions'));
  assert.ok(!args.includes('--permission-mode'));
  assert.ok(!args.includes('--allowedTools'));
});

test('a resume id is forwarded as --resume', () => {
  setToken('sk-ant-oat-x');
  const args = dockerArgsFor({
    cwd: PROJECT_DIR,
    supervisorHandle: 'claude1',
    resumeSessionId: 'sess-123',
  });
  const i = args.indexOf('--resume');
  assert.ok(i >= 0);
  assert.equal(args[i + 1], 'sess-123');
});

test('the invocation runs the image with --rm, never leaving a stopped container behind', () => {
  setToken('sk-ant-oat-x');
  const args = dockerArgsFor({ cwd: PROJECT_DIR, supervisorHandle: 'claude1' });
  assert.ok(args.includes('--rm'));
});

test('kill() stops the container by name via the daemon, not a raw signal to the docker-run client', async (t) => {
  setToken('sk-ant-oat-x');
  // 🛑 A RAW SIGTERM TO THE `docker run` CLIENT IS NOT THE CONTRACT. The
  // daemon ignores it (container-removal.test.ts, #148's real finding), so
  // `kill()` must shell out to `docker stop <name>` instead. This test
  // captures that argv rather than asserting the client died, which is a
  // signal-propagation detail a real daemon supplies and this mock does not.
  const { stopInvocations, runningClient } = mockDocker(t);

  const { spawnContainerized } = await import(
    `../../../src/supervise/drivers/containerized.js?kill-test=${Date.now()}`
  );
  const agent = spawnContainerized(claudeSpawn, { cwd: PROJECT_DIR, supervisorHandle: 'claude1' });

  agent.kill();

  assert.deepEqual(stopInvocations, [['stop', '-t', '60', 'chat-mcp-claude1']]);
  assert.ok(runningClient(), 'spawn mock was not invoked');
});

test('a per-handle shutdownGraceSeconds overrides the -t default', async (t) => {
  setToken('sk-ant-oat-x');
  const { stopInvocations } = mockDocker(t);

  const { spawnContainerized } = await import(
    `../../../src/supervise/drivers/containerized.js?grace-test=${Date.now()}`
  );
  const agent = spawnContainerized(claudeSpawn, {
    cwd: PROJECT_DIR,
    supervisorHandle: 'claude1',
    shutdownGraceSeconds: 5,
  });

  agent.kill();

  assert.deepEqual(stopInvocations, [['stop', '-t', '5', 'chat-mcp-claude1']]);
});

test('🛑 the container name is force-cleared BEFORE docker run, or a restart hits a name conflict', async (t) => {
  setToken('sk-ant-oat-x');
  // The name is fixed per handle, and `kill()` no longer waits for the
  // teardown — so without this, restarting a handle inside the grace window
  // gets `Conflict. The container name is already in use` from the daemon.
  // Ordering is the whole assertion: an `rm -f` after `run` clears nothing.
  const { calls } = mockDocker(t);

  const { spawnContainerized } = await import(
    `../../../src/supervise/drivers/containerized.js?rm-test=${Date.now()}`
  );
  spawnContainerized(claudeSpawn, { cwd: PROJECT_DIR, supervisorHandle: 'claude1' });

  assert.deepEqual(calls[0], ['rm', '-f', 'chat-mcp-claude1'], 'the first docker call must be rm -f');
  assert.equal(calls[1]?.[0], 'run', 'docker run must follow the rm -f, not precede it');
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
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'chat-mcp-ro-project-')));
  mkdirSync(join(dir, 'scripts', 'lib'), { recursive: true });

  return dir;
}

test('a declared read-only path is bind-mounted :ro at its path under the work dir', () => {
  setToken('sk-ant-oat-x');
  const dir = projectWithScripts();
  const args = dockerArgsFor({
    cwd: dir,
    supervisorHandle: 'claude1',
    readOnlyPaths: ['scripts'],
  });

  assert.ok(args.includes(`${dir}/scripts:${CONTAINER_PROJECT_DIR}/scripts:ro`));
});

test('🛑 the :ro mount comes AFTER the read-write project mount, or it is not layered over it', () => {
  setToken('sk-ant-oat-x');
  const dir = projectWithScripts();
  const args = dockerArgsFor({
    cwd: dir,
    supervisorHandle: 'claude1',
    readOnlyPaths: ['scripts'],
  });

  // Nested bind precedence is what makes this work at all: the inner mount has
  // to be layered over the wider one. A `:ro` emitted first is a different
  // command with a different result.
  const outer = args.indexOf(`${dir}:${CONTAINER_PROJECT_DIR}`);
  const inner = args.indexOf(`${dir}/scripts:${CONTAINER_PROJECT_DIR}/scripts:ro`);

  assert.ok(outer >= 0, 'the read-write project mount is missing');
  assert.ok(inner > outer, `expected the :ro mount at a later index than ${outer}, got ${inner}`);
});

test('🛑 the project mount itself stays READ-WRITE, so the agent can still edit the repo', () => {
  setToken('sk-ant-oat-x');
  const dir = projectWithScripts();
  const args = dockerArgsFor({
    cwd: dir,
    supervisorHandle: 'claude1',
    readOnlyPaths: ['scripts'],
  });

  assert.ok(args.includes(`${dir}:${CONTAINER_PROJECT_DIR}`));
  assert.ok(!args.includes(`${dir}:${CONTAINER_PROJECT_DIR}:ro`));
});

test('every declared path gets its own mount, including a nested one', () => {
  setToken('sk-ant-oat-x');
  const dir = projectWithScripts();
  const args = dockerArgsFor({
    cwd: dir,
    supervisorHandle: 'claude1',
    readOnlyPaths: ['scripts', 'scripts/lib'],
  });

  assert.ok(args.includes(`${dir}/scripts:${CONTAINER_PROJECT_DIR}/scripts:ro`));
  assert.ok(args.includes(`${dir}/scripts/lib:${CONTAINER_PROJECT_DIR}/scripts/lib:ro`));
});

test('🛑 chat-mcp SHIPS NO DEFAULT: no declared paths means no :ro mount at all', () => {
  setToken('sk-ant-oat-x');
  const dir = projectWithScripts();

  for (const opts of [
    { cwd: dir, supervisorHandle: 'claude1' },
    { cwd: dir, supervisorHandle: 'claude1', readOnlyPaths: [] },
  ]) {
    const args = dockerArgsFor(opts);
    // Deriving `scripts/` from a script path is what lee objected to: it would
    // encode one consumer's layout into chat-mcp.
    assert.ok(
      !args.some((arg) => arg.endsWith(':ro')),
      `expected no :ro mount, got ${args.filter((a) => a.endsWith(':ro')).join(', ')}`,
    );
  }
});

test('🛑 a declared path that is a SYMLINK OUT of the project REFUSES the spawn', () => {
  setToken('sk-ant-oat-x');
  const dir = projectWithScripts();
  symlinkSync('/etc', join(dir, 'conf'));

  // Mounting it would expose a host directory the project does not own. A
  // LEXICAL check cannot see this, which is the whole reason the driver calls
  // `checkedProjectPath`.
  assert.throws(
    () => dockerArgsFor({ cwd: dir, supervisorHandle: 'claude1', readOnlyPaths: ['conf'] }),
    /outside/,
  );
});

test('🛑 a declared path that is NOT ON DISK refuses, rather than letting docker create an empty one', () => {
  setToken('sk-ant-oat-x');
  const dir = projectWithScripts();

  // docker creates a missing host path as an empty directory, which would MASK
  // the real tree inside the container and read as "the gate script vanished".
  assert.throws(
    () => dockerArgsFor({ cwd: dir, supervisorHandle: 'claude1', readOnlyPaths: ['nope'] }),
    /does not exist/,
  );
});

test('🛑 an ABSOLUTE declared path refuses', () => {
  setToken('sk-ant-oat-x');
  const dir = projectWithScripts();

  assert.throws(
    () => dockerArgsFor({ cwd: dir, supervisorHandle: 'claude1', readOnlyPaths: ['/etc'] }),
    /relative/,
  );
});

test('🛑 a declared path that LEXICALLY escapes the project refuses', () => {
  setToken('sk-ant-oat-x');
  const dir = projectWithScripts();

  assert.throws(
    () =>
      dockerArgsFor({
        cwd: dir,
        supervisorHandle: 'claude1',
        readOnlyPaths: ['scripts/../../etc'],
      }),
    /inside the project/,
  );
});

test('🛑 a declared path containing a COLON refuses, rather than emitting a malformed mount spec', () => {
  setToken('sk-ant-oat-x');
  const dir = projectWithScripts();
  mkdirSync(join(dir, 'odd:name'));

  // docker's own parser rejects the four-field spec this would build, so the
  // whole spawn dies at `docker run` with `too many colons` instead of here.
  assert.throws(
    () => dockerArgsFor({ cwd: dir, supervisorHandle: 'claude1', readOnlyPaths: ['odd:name'] }),
    /colon/,
  );
});

test('🛑 a declared path that is a SYMLINK INSIDE the project REFUSES, or the real directory stays writable', () => {
  setToken('sk-ant-oat-x');
  const dir = projectWithScripts();
  mkdirSync(join(dir, 'real-scripts'));
  symlinkSync('real-scripts', join(dir, 'linked'));

  // Mounting `<dir>/real-scripts` at `/work/linked:ro` would leave
  // `/work/real-scripts` writable — the same host directory, under its real
  // name — and the broker resolves `linked/gate.sh` through the symlink too.
  assert.throws(
    () => dockerArgsFor({ cwd: dir, supervisorHandle: 'claude1', readOnlyPaths: ['linked'] }),
    /symlink or sits under one/,
  );
});

test('🛑 a declared path UNDER a symlinked directory refuses for the same reason', () => {
  setToken('sk-ant-oat-x');
  const dir = projectWithScripts();
  mkdirSync(join(dir, 'real-scripts', 'lib'), { recursive: true });
  symlinkSync('real-scripts', join(dir, 'linked'));

  assert.throws(
    () => dockerArgsFor({ cwd: dir, supervisorHandle: 'claude1', readOnlyPaths: ['linked/lib'] }),
    /symlink or sits under one/,
  );
});

test('🛑 EVERY spelling of the project ROOT refuses, not just the bare one', () => {
  setToken('sk-ant-oat-x');
  const dir = projectWithScripts();

  // All three normalise to the root. Mounting it would stop the agent editing
  // the repo it is working in, which is the cost lee explicitly did not accept.
  for (const spelling of ['.', './', 'scripts/..']) {
    assert.throws(
      () => dockerArgsFor({ cwd: dir, supervisorHandle: 'claude1', readOnlyPaths: [spelling] }),
      /project root/,
      `"${spelling}" was accepted`,
    );
  }
});

test('the container side is the NORMALISED path, never the raw declared spelling', () => {
  setToken('sk-ant-oat-x');
  const dir = projectWithScripts();

  for (const spelling of ['scripts/./lib', 'scripts//lib', 'scripts/lib/']) {
    const args = dockerArgsFor({
      cwd: dir,
      supervisorHandle: 'claude1',
      readOnlyPaths: [spelling],
    });

    assert.ok(
      args.includes(`${dir}/scripts/lib:${CONTAINER_PROJECT_DIR}/scripts/lib:ro`),
      `"${spelling}" emitted ${args.filter((a) => a.endsWith(':ro')).join(', ')}`,
    );
  }
});

test('a project directory reached through a SYMLINK still mounts its real paths', () => {
  setToken('sk-ant-oat-x');
  const real = projectWithScripts();
  const link = join(mkdtempSync(join(tmpdir(), 'chat-mcp-ro-link-')), 'proj');
  symlinkSync(real, link);

  // `opts.cwd` is whatever the operator registered, and on macOS `mkdtemp`
  // alone hands back a path under the `/var` symlink. The project dir is
  // resolved before the comparison, so this is a mount and not a refusal.
  const args = dockerArgsFor({ cwd: link, supervisorHandle: 'claude1', readOnlyPaths: ['scripts'] });

  assert.ok(args.includes(`${real}/scripts:${CONTAINER_PROJECT_DIR}/scripts:ro`));
});

/**
 * 🛑 #183. REFUSED AT SPAWN TOO, not only at registration. `projects.json` is a
 * file on disk, so a registration that predates this guard is still there, and
 * `opts.cwd` reaches the driver from `resolveCwd` rather than only from
 * `registerProject`.
 *
 * The argv is what mounts it, so this is the last place that can say no.
 */
test('🛑 a project dir ABOVE the state directory refuses the spawn argv', () => {
  setToken('sk-ant-oat-x');

  // Positive control: the same call with an ordinary project dir succeeds, so
  // the refusal below is the containment check and not a missing token.
  assert.ok(dockerArgsFor({ cwd: PROJECT_DIR, supervisorHandle: 'claude1' }).length > 0);

  assert.throws(
    () => dockerArgsFor({ cwd: dirname(realpathSync(stateDir())), supervisorHandle: 'claude1' }),
    /state directory/,
  );
});

/**
 * 🛑 #183, AND THE EXTRA MOUNTS ARE THE SURFACE A NAME-SCOPED AUDIT MISSES.
 * `mounts.json` is a file, so a key registered before the guard existed is
 * still live, and this loop is the last thing that can refuse it.
 */
test('🛑 an extra mount ABOVE the state directory refuses the spawn argv', () => {
  setToken('sk-ant-oat-x');

  // 🛑 WRITTEN STRAIGHT TO THE FILE, because `registerMount` now refuses it.
  // That IS the case under test: a key registered before the guard existed.
  writeFileSync(
    mountsPath(),
    JSON.stringify({ agents: { claude8: { evil: dirname(realpathSync(stateDir())) } } }),
  );

  assert.throws(
    () => dockerArgsFor({ cwd: PROJECT_DIR, supervisorHandle: 'claude8' }),
    /state directory/,
  );
});
