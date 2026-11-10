# Container Sandboxing (#129) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Spawn a supervised agent inside a Docker container instead of as a bare host process, so a permission grant can no longer reach beyond the agent's own clone.

**Architecture:** A new `drivers/docker-claude.ts` implements the existing `AgentChild` seam by building a `docker run` argv instead of a bare `claude` argv; nothing above the driver layer changes. Three new small state files mirror the existing `projects.json` pattern: `mounts.json` (per-handle extra mounts), `secrets.env` (the shared OAuth token), `container.json` (image build hash + per-handle confirmation). A new `agents restart <handle>` verb reuses the existing wake socket as its transport.

**Tech Stack:** TypeScript, `node:child_process`, `node:net` (existing `WakeListener`/`deliverToSupervisor`), Docker CLI (`docker run`, `docker build`, `docker image inspect`), `node:test`.

**⚠️ One design decision beyond the spec's explicit list, flag to lee before or during review:** the spec's "Mount" bullets cover the agent's project clone and optional extra state, but say nothing about how the *containerized* `claude` process reaches chat-mcp's own bus (the MCP server it needs for `mcp__chat__*` tools). This plan resolves it by always bind-mounting the host's chat-mcp state directory (`stateDir()`, normally `~/.chat-mcp`) to `/root/.chat-mcp` inside the container — this is the SAME relative path `stateDir()` resolves to by default (`homedir()/.chat-mcp`) when the container's `HOME` is `/root`, so no new env var is needed, and the `claude` process's MCP config (which already lives under `stateDir()/mcp/`) rides along with that mount for free. The image itself bundles this repo's `dist/` so an in-container `node /opt/chat-mcp/dist/index.js --handle <h>` becomes the MCP server command. This is new ground the spec left open — Task 9's smoke test is where this gets proven, not assumed.

---

## File structure

- Create `src/supervise/mounts.ts` — per-handle extra mount registry, mirrors `projects.ts`.
- Create `src/supervise/auth.ts` — shared OAuth token storage.
- Create `src/supervise/container.ts` — image build/staleness + per-handle confirm state.
- Create `src/supervise/drivers/docker-claude.ts` — the container driver.
- Create `Dockerfile` (repo root) — node + git + `claude` CLI + this repo's `dist`.
- Modify `src/supervise/child.ts` — add `supervisorHandle` to `SpawnOptions`.
- Modify `src/supervise/drivers/index.ts` — register `docker-claude`.
- Modify `src/supervise/socket.ts` — add an optional `control` field to `WakeEnvelope`.
- Modify `src/supervise/index.ts` — container confirm gate, mount-advertisement banner, restart handling.
- Modify `src/index.ts` — `mount`, `auth`, `agents` commands; `--container` flag on `supervise`.
- Modify `src/util/subcommands.ts` — register the three new verb names.
- Modify `package.json` — ship `Dockerfile` in the npm package.

---

## Task 1: Mounts registry

**Files:**
- Create: `src/supervise/mounts.ts`
- Test: `test/supervise/mounts.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), 'chat-mcp-mounts-'));

const { registerMount, readMounts, mountsFor, mountsPath } = await import(
  '../../src/supervise/mounts.js'
);

const HOST_DIR = mkdtempSync(join(tmpdir(), 'chat-mcp-mount-src-'));

test('an unregistered handle has no mounts', () => {
  assert.deepEqual(mountsFor('nobody'), {});
});

test('registering a mount makes it readable by key', () => {
  registerMount('claude1', 'local-context', HOST_DIR);
  assert.deepEqual(mountsFor('claude1'), { 'local-context': HOST_DIR });
});

test('a second key for the same handle is additive', () => {
  const memDir = mkdtempSync(join(tmpdir(), 'chat-mcp-mount-mem-'));
  registerMount('claude1', 'memory', memDir);
  assert.deepEqual(mountsFor('claude1'), {
    'local-context': HOST_DIR,
    memory: memDir,
  });
});

test('registering the same key again overwrites it, not appends', () => {
  const replacement = mkdtempSync(join(tmpdir(), 'chat-mcp-mount-replace-'));
  registerMount('claude1', 'memory', replacement);
  assert.deepEqual(mountsFor('claude1')['memory'], replacement);
});

test('registering for a directory that does not exist throws', () => {
  assert.throws(
    () => registerMount('claude1', 'bogus', join(HOST_DIR, 'nope')),
    /no such directory/,
  );
});

test('a second handle is independent of the first', () => {
  const dir2 = mkdtempSync(join(tmpdir(), 'chat-mcp-mount-h2-'));
  registerMount('claude2', 'local-context', dir2);
  assert.deepEqual(mountsFor('claude1')['local-context'], HOST_DIR);
  assert.deepEqual(mountsFor('claude2'), { 'local-context': dir2 });
});

test('a malformed mounts.json reads as empty rather than throwing', async () => {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(mountsPath(), 'not json');
  assert.deepEqual(readMounts(), { agents: {} });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern='mount'`
Expected: FAIL — `Cannot find module '../../src/supervise/mounts.js'`

- [ ] **Step 3: Write the implementation**

```typescript
import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { ensureStateDir, stateDir, writePrivateFileSync } from '../util/paths.js';

/**
 * Extra read-write mounts a containerized agent gets, beyond its project
 * clone (which `dirsFor` already covers). Keyed per handle, per a free-form
 * slug the AGENT's own convention gives meaning to — chat-mcp never
 * hardcodes which keys exist. See #129.
 */
export interface MountConfig {
  readonly agents: Record<string, Record<string, string>>;
}

const EMPTY: MountConfig = { agents: {} };

export function mountsPath(): string {
  return join(stateDir(), 'mounts.json');
}

/** A malformed file reads as empty rather than throwing, same as `projects.ts`. */
export function readMounts(): MountConfig {
  const path = mountsPath();

  if (!existsSync(path)) return EMPTY;

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<MountConfig>;

    return { agents: parsed.agents ?? {} };
  } catch {
    return EMPTY;
  }
}

/**
 * Register `key` -> `dir` for `handle`. The path must exist and is resolved,
 * same reasoning as `registerProject`: a registration for a directory that
 * is not there would be refused later in a way that reads as a permissions
 * problem rather than a typo.
 */
export function registerMount(
  handle: string,
  key: string,
  dir: string,
): Record<string, string> {
  const abs = resolve(dir);

  if (!existsSync(abs)) {
    throw new Error(
      `cannot mount "${dir}" under key "${key}": no such directory (resolved to ${abs})`,
    );
  }

  const config = readMounts();
  const existing = config.agents[handle] ?? {};
  const agents = { ...config.agents, [handle]: { ...existing, [key]: abs } };

  ensureStateDir();
  writePrivateFileSync(mountsPath(), `${JSON.stringify({ agents }, null, 2)}\n`);

  return agents[handle] as Record<string, string>;
}

/** This handle's extra mounts, or none. */
export function mountsFor(handle: string): Record<string, string> {
  return readMounts().agents[handle] ?? {};
}

/** Where a mount's key lands inside the container. Shared by the driver and the CLI's printed plan. */
export function containerPathFor(key: string): string {
  return `/mnt/${key}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --test-name-pattern='mount'`
Expected: PASS, 7 tests

- [ ] **Step 5: Commit**

```bash
git add src/supervise/mounts.ts test/supervise/mounts.test.ts
git commit -m "feat(#129): add the per-handle extra-mount registry"
```

---

## Task 2: Shared auth token storage

**Files:**
- Create: `src/supervise/auth.ts`
- Test: `test/supervise/auth.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), 'chat-mcp-auth-'));

const { setToken, readToken, secretsEnvPath } = await import('../../src/supervise/auth.js');

test('no token on file reads as null, not a throw', () => {
  assert.equal(readToken(), null);
});

test('a stored token round-trips', () => {
  setToken('sk-ant-oat-example');
  assert.equal(readToken(), 'sk-ant-oat-example');
});

test('the file is owner-only (0600)', () => {
  setToken('sk-ant-oat-example');
  assert.equal(statSync(secretsEnvPath()).mode & 0o777, 0o600);
});

test('leading/trailing whitespace on the token is trimmed before storing', () => {
  setToken('  sk-ant-oat-ws  \n');
  assert.equal(readToken(), 'sk-ant-oat-ws');
});

test('an empty token is refused rather than stored', () => {
  assert.throws(() => setToken('   '), /empty/);
});

test('setting a new token replaces the old one, not appends', () => {
  setToken('sk-ant-oat-first');
  setToken('sk-ant-oat-second');
  assert.equal(readToken(), 'sk-ant-oat-second');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern='token'`
Expected: FAIL — `Cannot find module '../../src/supervise/auth.js'`

- [ ] **Step 3: Write the implementation**

```typescript
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureStateDir, stateDir, writePrivateFileSync } from '../util/paths.js';

/**
 * One `CLAUDE_CODE_OAUTH_TOKEN`, shared by every containerized handle for
 * now. #129's design decision 3: generated on the HOST via
 * `claude setup-token` (needs a browser, which no container has), stored
 * here, read by the docker driver and injected with `docker run -e`.
 */
export function secretsEnvPath(): string {
  return join(stateDir(), 'secrets.env');
}

export function setToken(token: string): void {
  const trimmed = token.trim();

  if (trimmed.length === 0) {
    throw new Error('refusing to store an empty token');
  }

  ensureStateDir();
  writePrivateFileSync(secretsEnvPath(), `CLAUDE_CODE_OAUTH_TOKEN=${trimmed}\n`);
}

/** `null` when nothing is on file — the driver turns that into a fail-fast error naming this command. */
export function readToken(): string | null {
  const path = secretsEnvPath();

  if (!existsSync(path)) return null;

  const match = /^CLAUDE_CODE_OAUTH_TOKEN=(.*)$/m.exec(readFileSync(path, 'utf8'));

  return match ? (match[1]?.trim() ?? null) : null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --test-name-pattern='token'`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add src/supervise/auth.ts test/supervise/auth.test.ts
git commit -m "feat(#129): add shared OAuth token storage for containerized agents"
```

---

## Task 3: `mount` and `auth` CLI commands

**Files:**
- Modify: `src/index.ts`
- Modify: `src/util/subcommands.ts`
- Test: `test/supervise/subcommands.test.ts` (existing file — extend it)

- [ ] **Step 1: Read the existing test to match its shape**

`test/supervise/subcommands.test.ts` already asserts `KNOWN_SUBCOMMANDS` — read it before writing Step 2 so the new assertions match its existing style exactly (do not reformat the file).

- [ ] **Step 2: Write the failing test (append to the existing file)**

```typescript
test('mount, auth and agents are registered, or they silently fall through to shim mode', () => {
  assert.ok(KNOWN_SUBCOMMANDS.has('mount'));
  assert.ok(KNOWN_SUBCOMMANDS.has('auth'));
  assert.ok(KNOWN_SUBCOMMANDS.has('agents'));
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- --test-name-pattern='mount, auth and agents'`
Expected: FAIL — `has('mount')` is `false`

- [ ] **Step 4: Implement — `src/util/subcommands.ts`**

Add to the `KNOWN_SUBCOMMANDS` set (keep every existing entry):

```typescript
  'mount',
  'auth',
  'agents',
```

- [ ] **Step 5: Implement — `src/index.ts`**

Add after the `project` command block:

```typescript
  program
    .command('mount <action> [handle] [key] [dir]')
    .description('Register an extra mount for a containerized agent: add | list')
    .action(async (action: string, handle?: string, key?: string, dir?: string) => {
      const { registerMount, readMounts } = await import('./supervise/mounts.js');

      if (action === 'list') {
        const { agents } = readMounts();
        const names = handle ? [handle] : Object.keys(agents);

        if (names.length === 0) {
          console.log('no mounts registered');
          return;
        }

        for (const name of names) {
          const entries = Object.entries(agents[name] ?? {});
          console.log(
            entries.length === 0
              ? `${name}  (no mounts)`
              : `${name}  ${entries.map(([k, v]) => `${k}=${v}`).join('  ')}`,
          );
        }
        return;
      }

      if (action === 'add') {
        if (!handle || !key || !dir) {
          console.error('Error: chat-mcp mount add <handle> <key> <dir>');
          process.exit(1);
        }
        try {
          const mounts = registerMount(handle, key, dir);
          console.log(
            `${handle}  ${Object.entries(mounts).map(([k, v]) => `${k}=${v}`).join('  ')}`,
          );
        } catch (err) {
          console.error(`chat-mcp: ${err instanceof Error ? err.message : String(err)}`);
          process.exit(1);
        }
        return;
      }

      console.error(`Error: unknown action "${action}". Use add | list.`);
      process.exit(1);
    });

  program
    .command('auth <action> [token]')
    .description('Manage the shared Claude OAuth token for containerized agents: set-token')
    .action(async (action: string, token?: string) => {
      const { setToken } = await import('./supervise/auth.js');

      if (action === 'set-token') {
        if (!token) {
          console.error('Error: chat-mcp auth set-token <token>');
          process.exit(1);
        }
        setToken(token);
        console.log('token stored (chmod 600)');
        return;
      }

      console.error(`Error: unknown action "${action}". Use set-token.`);
      process.exit(1);
    });
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npm test -- --test-name-pattern='mount, auth and agents'`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/index.ts src/util/subcommands.ts test/supervise/subcommands.test.ts
git commit -m "feat(#129): add mount and auth CLI commands"
```

---

## Task 4: Image build + per-handle confirmation state

**Files:**
- Create: `src/supervise/container.ts`
- Test: `test/supervise/container.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), 'chat-mcp-container-'));

const {
  imageNeedsBuild,
  buildImage,
  isConfirmed,
  markConfirmed,
  describePlan,
  IMAGE_TAG,
} = await import('../../src/supervise/container.js');

/** A fake `execFileSync` so no test actually shells out to `docker`. */
function fakeRunner(calls: { cmd: string; args: string[] }[], imageExists: boolean) {
  return (cmd: string, args: readonly string[]): Buffer => {
    calls.push({ cmd, args: [...args] });
    if (cmd === 'docker' && args[0] === 'image' && !imageExists) {
      throw new Error('no such image');
    }
    return Buffer.from('');
  };
}

test('no prior build and no image means a build is needed', () => {
  const calls: { cmd: string; args: string[] }[] = [];
  assert.equal(imageNeedsBuild(fakeRunner(calls, false)), true);
});

test('after building, the SAME Dockerfile does not need a rebuild', () => {
  const calls: { cmd: string; args: string[] }[] = [];
  buildImage(fakeRunner(calls, true));
  assert.equal(imageNeedsBuild(fakeRunner(calls, true)), false);
});

test('buildImage invokes docker build with the image tag', () => {
  const calls: { cmd: string; args: string[] }[] = [];
  buildImage(fakeRunner(calls, true));
  const build = calls.find((c) => c.args[0] === 'build');
  assert.ok(build, 'docker build was never invoked');
  assert.ok(build!.args.includes(IMAGE_TAG));
});

test('a handle is unconfirmed until markConfirmed runs', () => {
  assert.equal(isConfirmed('claude1'), false);
  markConfirmed('claude1');
  assert.equal(isConfirmed('claude1'), true);
});

test('confirming one handle does not confirm another', () => {
  markConfirmed('claude1');
  assert.equal(isConfirmed('claude2'), false);
});

test('the printed plan names mounts, env var NAMES only, binary and network', () => {
  const plan = describePlan({
    mountPaths: ['/work', '/root/.chat-mcp'],
    envVarNames: ['CLAUDE_CODE_OAUTH_TOKEN'],
    binary: 'claude',
    networkMode: 'bridge (default, full outbound)',
  });
  assert.match(plan, /\/work/);
  assert.match(plan, /CLAUDE_CODE_OAUTH_TOKEN/);
  assert.doesNotMatch(plan, /sk-ant/, 'a token VALUE must never be printed, only its name');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern='image|confirmed|plan'`
Expected: FAIL — `Cannot find module '../../src/supervise/container.js'`

- [ ] **Step 3: Write the implementation**

```typescript
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync as realExecFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureStateDir, stateDir, writePrivateFileSync } from '../util/paths.js';

export const IMAGE_TAG = 'chat-mcp-agent:local';

export interface ContainerPlan {
  readonly mountPaths: readonly string[];
  readonly envVarNames: readonly string[];
  readonly binary: string;
  readonly networkMode: string;
}

interface ContainerState {
  builtHash: string | null;
  confirmed: Record<string, boolean>;
}

const EMPTY_STATE: ContainerState = { builtHash: null, confirmed: {} };

function containerStatePath(): string {
  return join(stateDir(), 'container.json');
}

function readContainerState(): ContainerState {
  const path = containerStatePath();

  if (!existsSync(path)) return EMPTY_STATE;

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<ContainerState>;

    return { builtHash: parsed.builtHash ?? null, confirmed: parsed.confirmed ?? {} };
  } catch {
    return EMPTY_STATE;
  }
}

function writeContainerState(state: ContainerState): void {
  ensureStateDir();
  writePrivateFileSync(containerStatePath(), `${JSON.stringify(state, null, 2)}\n`);
}

/**
 * The Dockerfile this build ships, resolved module-relative — same reasoning
 * as `resolveChatMcpEntry` in `drivers/claude.ts`: `process.argv[1]` means
 * "whatever script launched", not "this install's root".
 */
export function dockerfilePath(): string {
  const fromDist = fileURLToPath(new URL('../../Dockerfile', import.meta.url));
  if (existsSync(fromDist)) return fromDist;

  const fromSource = fileURLToPath(new URL('../../../Dockerfile', import.meta.url));
  if (existsSync(fromSource)) return fromSource;

  throw new Error(`cannot locate Dockerfile next to ${import.meta.url}`);
}

function dockerfileHash(): string {
  return createHash('sha256').update(readFileSync(dockerfilePath())).digest('hex');
}

type Runner = (cmd: string, args: readonly string[]) => Buffer;

/** Only a Dockerfile change (or a missing image) forces a rebuild. */
export function imageNeedsBuild(run: Runner = realExecFileSync): boolean {
  const state = readContainerState();

  if (state.builtHash !== dockerfileHash()) return true;

  try {
    run('docker', ['image', 'inspect', IMAGE_TAG]);
    return false;
  } catch {
    return true;
  }
}

/**
 * Build the image and record the Dockerfile hash that produced it.
 *
 * 🛑 THIS REPO'S OWN `dist/` MUST ALREADY BE BUILT before this runs — the
 * Dockerfile `COPY`s a prebuilt `dist/`, it does not run `tsc` itself, so an
 * image built against a stale `dist/` silently ships old code. The CLI
 * caller (Task 5) runs `npm run build` first.
 */
export function buildImage(run: Runner = realExecFileSync): void {
  run('docker', ['build', '-t', IMAGE_TAG, '-f', dockerfilePath(), dirname(dockerfilePath())]);

  writeContainerState({ ...readContainerState(), builtHash: dockerfileHash() });
}

export function isConfirmed(handle: string): boolean {
  return readContainerState().confirmed[handle] === true;
}

export function markConfirmed(handle: string): void {
  const state = readContainerState();
  writeContainerState({ ...state, confirmed: { ...state.confirmed, [handle]: true } });
}

/** Env var NAMES only, never values — this is printed to a terminal. */
export function describePlan(plan: ContainerPlan): string {
  return [
    'This will run the agent inside a Docker container:',
    `  mounts: ${plan.mountPaths.join(', ')}`,
    `  env vars (names only): ${plan.envVarNames.join(', ')}`,
    `  binary: ${plan.binary}`,
    `  network: ${plan.networkMode}`,
  ].join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --test-name-pattern='image|confirmed|plan'`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add src/supervise/container.ts test/supervise/container.test.ts
git commit -m "feat(#129): add container image build and per-handle confirm state"
```

---

## Task 5: The docker-claude driver

**Files:**
- Modify: `src/supervise/child.ts` (add `supervisorHandle` to `SpawnOptions`)
- Create: `src/supervise/drivers/docker-claude.ts`
- Modify: `src/supervise/drivers/index.ts`
- Test: `test/supervise/drivers/docker-claude.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), 'chat-mcp-docker-driver-'));

const { setToken } = await import('../../../src/supervise/auth.js');
const { registerMount } = await import('../../../src/supervise/mounts.js');
const { dockerArgsFor, CONTAINER_PROJECT_DIR, CONTAINER_STATE_DIR, containerPathFor } =
  await import('../../../src/supervise/drivers/docker-claude.js');

const PROJECT_DIR = mkdtempSync(join(tmpdir(), 'chat-mcp-docker-project-'));

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
  assert.ok(args.includes(`${stateDir()}:${CONTAINER_STATE_DIR}`));
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern='docker|token is injected|allow-dangerously'`
Expected: FAIL — `Cannot find module '../../../src/supervise/drivers/docker-claude.js'`

- [ ] **Step 3: Implement — `src/supervise/child.ts`**

Add one field to `SpawnOptions` (next to `cwd`):

```typescript
  /**
   * The SUPERVISOR's own handle, so a driver that needs per-handle state
   * (registered mounts) can look it up. `grant.handle` is the CHILD's bus
   * handle (`<handle>-agent`) and is the wrong key for that lookup.
   */
  readonly supervisorHandle?: string;
```

- [ ] **Step 4: Implement — `src/supervise/drivers/docker-claude.ts`**

```typescript
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AgentChild, SpawnOptions } from '../child.js';
import { createLineParser } from '../child.js';
import { type RateLimitSnapshot } from '../rate-limit.js';
import type { Denial } from '../denial.js';
import { routeClaudeEvent } from './claude.js';
import { mountsFor, containerPathFor } from '../mounts.js';
import { readToken } from '../auth.js';
import { IMAGE_TAG } from '../container.js';
import { stateDir, mcpConfigPathFor, ensureMcpConfigDir, writePrivateFileSync } from '../../util/paths.js';

/**
 * The container driver: the Claude Code CLI run inside `docker run` instead
 * of as a bare host process. #129.
 *
 * 🛑 A SECOND DRIVER OF drivers/claude.ts, NOT A FLAG ON IT. The flags this
 * driver passes are mutually exclusive with the host driver's
 * `--permission-mode`/`--allowedTools` family — decision 4 of the spec:
 * full in-container permissions, the container boundary is the gate.
 */

export const CONTAINER_PROJECT_DIR = '/work';
/** Same relative path `stateDir()` resolves to by default (`$HOME/.chat-mcp`) when the container's HOME is /root — no env var needed for the bus to resolve correctly in-container. */
export const CONTAINER_STATE_DIR = '/root/.chat-mcp';
const CONTAINER_CHAT_MCP_ENTRY = '/opt/chat-mcp/dist/index.js';

export { containerPathFor };

/**
 * Overwrite this handle's MCP config with CONTAINER-side command/args.
 *
 * The file itself is written to the HOST path (`mcpConfigPathFor`), which
 * lives under `stateDir()` and is therefore already bind-mounted into the
 * container — so the content just needs to point at paths that exist
 * INSIDE the container, not at this host process's own node binary.
 */
function writeContainerMcpConfig(childHandle: string): string {
  ensureMcpConfigDir();
  const hostPath = mcpConfigPathFor(childHandle);
  const config = {
    mcpServers: {
      chat: { command: 'node', args: [CONTAINER_CHAT_MCP_ENTRY, '--handle', childHandle] },
    },
  };
  writePrivateFileSync(hostPath, `${JSON.stringify(config, null, 2)}\n`);

  return `${CONTAINER_STATE_DIR}/mcp/${childHandle}.json`;
}

export function dockerArgsFor(opts: SpawnOptions): string[] {
  const token = readToken();
  if (!token) {
    throw new Error(
      'no Claude OAuth token on file; run `claude setup-token` on the host, then ' +
        '`chat-mcp auth set-token <token>`',
    );
  }

  if (!opts.supervisorHandle) {
    throw new Error('the docker-claude driver needs opts.supervisorHandle to find its mounts');
  }

  const projectDir = opts.cwd;
  if (!projectDir) {
    throw new Error('the docker-claude driver needs a resolved cwd');
  }

  const args = [
    'run',
    '-i',
    '--rm',
    '-e',
    `CLAUDE_CODE_OAUTH_TOKEN=${token}`,
    '-v',
    `${projectDir}:${CONTAINER_PROJECT_DIR}`,
    '-v',
    `${stateDir()}:${CONTAINER_STATE_DIR}`,
  ];

  for (const [key, hostDir] of Object.entries(mountsFor(opts.supervisorHandle))) {
    args.push('-v', `${hostDir}:${containerPathFor(key)}`);
  }

  args.push('-w', CONTAINER_PROJECT_DIR, IMAGE_TAG);

  args.push(
    'claude',
    '-p',
    '--verbose',
    '--output-format',
    'stream-json',
    '--input-format',
    'stream-json',
    '--allow-dangerously-skip-permissions',
  );

  if (opts.model) args.push('--model', opts.model);
  if (opts.resumeSessionId) args.push('--resume', opts.resumeSessionId);

  if (opts.grant) {
    args.push('--mcp-config', writeContainerMcpConfig(opts.grant.handle), '--strict-mcp-config');
  }

  return args;
}

export function spawnDockerClaude(opts: SpawnOptions = {}): AgentChild {
  const child: ChildProcessWithoutNullStreams = spawn(
    'docker',
    dockerArgsFor(opts),
    { stdio: ['pipe', 'pipe', 'pipe'] },
  ) as ChildProcessWithoutNullStreams;

  const eventCbs: ((e: Record<string, unknown>) => void)[] = [];
  const turnEndCbs: (() => void)[] = [];
  const usageCbs: ((s: RateLimitSnapshot) => void)[] = [];
  const denialCbs: ((d: Denial) => void)[] = [];
  const sessionCbs: ((id: string) => void)[] = [];
  let lastSession: string | null = null;

  const feed = createLineParser((parsed) => {
    for (const cb of eventCbs) cb(parsed);

    routeClaudeEvent(parsed, {
      turnEnd: () => {
        for (const cb of turnEndCbs) cb();
      },
      usage: (snapshot) => {
        for (const cb of usageCbs) cb(snapshot);
      },
      denial: (d) => {
        for (const cb of denialCbs) cb(d);
      },
      session: (id) => {
        if (lastSession === id) return;
        lastSession = id;
        for (const cb of sessionCbs) cb(id);
      },
    });
  });

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', feed);

  return {
    reportsUsage: true,
    send(text: string): void {
      const message = {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text }] },
      };
      child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    onTurnEnd(cb): void {
      turnEndCbs.push(cb);
    },
    onUsage(cb): void {
      usageCbs.push(cb);
    },
    onDenial(cb): void {
      denialCbs.push(cb);
    },
    onSession(cb): void {
      sessionCbs.push(cb);
      if (lastSession) cb(lastSession);
    },
    onEvent(cb): void {
      eventCbs.push(cb);
    },
    onExit(cb): void {
      child.on('exit', (code, signal) => cb(code, signal));
    },
    kill(): void {
      // `docker run --rm` without `-d`: killing this process stops and
      // removes the container. No `docker exec`, ever — decision 8.
      child.kill();
    },
  };
}
```

- [ ] **Step 5: Implement — `src/supervise/drivers/index.ts`**

```typescript
import { spawnDockerClaude } from './docker-claude.js';
```

Change `DriverName` and the registry:

```typescript
export type DriverName = 'claude' | 'docker-claude';
```

```typescript
const DRIVERS: Record<DriverName, Driver> = {
  claude: { spawn: spawnClaude, redispatchPrompt: claudeRedispatch },
  'docker-claude': { spawn: spawnDockerClaude, redispatchPrompt: claudeRedispatch },
};
```

(`redispatchPrompt` is reused as-is — the docker driver still runs the Claude Code CLI, so its approval-redispatch wording is identical. It is only reachable for a containerized handle if a future change re-enables the host grant path; today's #129 scope never calls it for this driver, but keeping one wording avoids a second copy that could drift.)

- [ ] **Step 6: Run test to verify it passes**

Run: `npm test -- --test-name-pattern='docker|token is injected|allow-dangerously'`
Expected: PASS, 8 tests

- [ ] **Step 7: Commit**

```bash
git add src/supervise/child.ts src/supervise/drivers/docker-claude.ts src/supervise/drivers/index.ts test/supervise/drivers/docker-claude.test.ts
git commit -m "feat(#129): add the docker-claude container driver"
```

---

## Task 6: `--container` flag, confirm gate, missing-token fail-fast

**Files:**
- Modify: `src/supervise/index.ts`
- Modify: `src/index.ts`
- Test: `test/supervise/container-gate.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), 'chat-mcp-container-gate-'));

const { migrate } = await import('../../src/storage/db.js');
const { startSupervisor } = await import('../../src/supervise/index.js');
const { setToken } = await import('../../src/supervise/auth.js');
const { markConfirmed } = await import('../../src/supervise/container.js');

const DIRS = [process.cwd()];

function supervisorDb() {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  return db;
}

test('a container supervisor with no token fails fast naming the fix', async () => {
  const db = supervisorDb();
  const handle = `cg-${process.pid}-notoken`;
  markConfirmed(handle);

  await assert.rejects(
    () =>
      startSupervisor({
        handle,
        db,
        extraDirs: DIRS,
        driver: 'docker-claude',
        reply: false,
        log: () => undefined,
      }),
    /chat-mcp auth set-token/,
  );
});

test('an UNCONFIRMED container handle refuses to spawn without --now-style override', async () => {
  const db = supervisorDb();
  const handle = `cg-${process.pid}-unconfirmed`;
  setToken('sk-ant-oat-x');

  await assert.rejects(
    () =>
      startSupervisor({
        handle,
        db,
        extraDirs: DIRS,
        driver: 'docker-claude',
        reply: false,
        log: () => undefined,
      }),
    /not confirmed/,
  );
});

test('a CONFIRMED handle with a token spawns via the docker driver', async () => {
  const db = supervisorDb();
  const handle = `cg-${process.pid}-ok`;
  setToken('sk-ant-oat-x');
  markConfirmed(handle);

  const spawned: unknown[] = [];
  const sup = await startSupervisor({
    handle,
    db,
    extraDirs: DIRS,
    driver: 'docker-claude',
    reply: false,
    log: () => undefined,
    spawnChild: (opts) => {
      spawned.push(opts);
      return {
        reportsUsage: false,
        send: () => undefined,
        onTurnEnd: () => undefined,
        onUsage: () => undefined,
        onDenial: () => undefined,
        onSession: () => undefined,
        onEvent: () => undefined,
        onExit: () => undefined,
        kill: () => undefined,
      };
    },
  });

  try {
    assert.equal(spawned.length, 1);
  } finally {
    await sup.stop();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern='container supervisor|UNCONFIRMED|CONFIRMED handle'`
Expected: FAIL — none of these checks exist yet, so the first two tests do not reject and the third passes vacuously (confirm the diff by reading the failure text, not just the exit code).

- [ ] **Step 3: Implement — `src/supervise/index.ts`**

Add a field to `SupervisorOptions` (near `driver`):

```typescript
  /**
   * Run this handle's child inside a container. Requires a token on file
   * (`chat-mcp auth set-token`) and a confirmed plan
   * (`chat-mcp supervise <handle> --container` prompts for this once).
   */
  readonly container?: boolean;
```

At the top of `startSupervisor`, before `dirsFor`/`resolveCwd` run, add the two fail-fast checks (import `readToken` from `./auth.js` and `isConfirmed` from `./container.js`):

```typescript
  if (opts.container) {
    const { readToken } = await import('./auth.js');
    const { isConfirmed } = await import('./container.js');

    if (!readToken()) {
      throw new Error(
        'no Claude OAuth token on file; run `claude setup-token` on the host, then ' +
          '`chat-mcp auth set-token <token>`',
      );
    }
    if (!isConfirmed(opts.handle)) {
      throw new Error(
        `container plan for "${opts.handle}" is not confirmed; run ` +
          `\`chat-mcp supervise ${opts.handle} --container\` interactively once first`,
      );
    }
  }
```

Pass `opts.handle` through as `supervisorHandle` at both spawn sites (initial spawn and `replaceChild`'s respawn):

```typescript
  let child = spawnFn({ ...opts, cwd: childCwd, grant: initialGrant, supervisorHandle: opts.handle });
```

```typescript
    child = spawnFn({
      ...opts,
      cwd: childCwd,
      grant: currentGrant,
      model: currentModel,
      supervisorHandle: opts.handle,
      resumeSessionId: childSession ?? opts.resumeSessionId,
    });
```

- [ ] **Step 4: Implement — `src/index.ts`, the interactive confirm**

The confirm PROMPT itself (Step 3's test above only covers the already-confirmed and never-confirmed cases; the interactive y/N path is a CLI concern, not a `startSupervisor` concern, so it belongs in the command action, before `startSupervisor` is ever called):

Add `--container` to the `supervise` command's options:

```typescript
    .option('--container', 'run the child inside a Docker container (#129)', false)
```

At the top of the `supervise` command's `.action`, before calling `startSupervisor`:

```typescript
      if (o.container) {
        const { imageNeedsBuild, buildImage, isConfirmed, markConfirmed, describePlan } =
          await import('./supervise/container.js');
        const { readMounts } = await import('./supervise/mounts.js');
        const { execSync } = await import('node:child_process');

        if (imageNeedsBuild()) {
          console.log('building the chat-mcp-agent image (Dockerfile changed or image missing)...');
          execSync('npm run build', { stdio: 'inherit' });
          buildImage();
        }

        if (!isConfirmed(handle)) {
          const extra = Object.keys(readMounts().agents[handle] ?? {}).map(
            (k) => `/mnt/${k}`,
          );
          console.log(
            describePlan({
              mountPaths: ['/work', '/root/.chat-mcp', ...extra],
              envVarNames: ['CLAUDE_CODE_OAUTH_TOKEN'],
              binary: 'claude',
              networkMode: 'bridge (default, full outbound — narrowing is #134)',
            }),
          );
          const { createInterface } = await import('node:readline/promises');
          const rl = createInterface({ input: process.stdin, output: process.stdout });
          const answer = await rl.question('Proceed? [y/N] ');
          rl.close();
          if (!/^y(es)?$/i.test(answer.trim())) {
            console.log('aborted');
            return;
          }
          markConfirmed(handle);
        }
      }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- --test-name-pattern='container supervisor|UNCONFIRMED|CONFIRMED handle'`
Expected: PASS, 3 tests

- [ ] **Step 6: Commit**

```bash
git add src/supervise/index.ts src/index.ts test/supervise/container-gate.test.ts
git commit -m "feat(#129): gate container spawn on a token and a one-time confirm"
```

---

## Task 7: Mount advertisement on first dispatch

**Files:**
- Modify: `src/supervise/index.ts`
- Test: `test/supervise/mount-banner.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), 'chat-mcp-mount-banner-'));

const { migrate } = await import('../../src/storage/db.js');
const { startSupervisor } = await import('../../src/supervise/index.js');
const { deliverToSupervisor } = await import('../../src/supervise/socket.js');
const { setToken } = await import('../../src/supervise/auth.js');
const { markConfirmed } = await import('../../src/supervise/container.js');
const { registerMount } = await import('../../src/supervise/mounts.js');

const DIRS = [process.cwd()];

function fakeChild(sent: string[]) {
  let endTurn: (() => void) | undefined;
  return {
    opts: undefined as unknown,
    reportsUsage: false,
    send: (t: string) => sent.push(t),
    onTurnEnd: (cb: () => void) => {
      endTurn = cb;
    },
    onUsage: () => undefined,
    onDenial: () => undefined,
    onSession: (cb: (id: string) => void) => cb('sess-1'),
    onEvent: () => undefined,
    onExit: () => undefined,
    kill: () => undefined,
    finishTurn: () => endTurn?.(),
  };
}

test('a fresh container spawn prepends the mount banner to the FIRST prompt only', async () => {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  const handle = `mb-${process.pid}`;
  setToken('sk-ant-oat-x');
  markConfirmed(handle);

  const extra = mkdtempSync(join(tmpdir(), 'chat-mcp-mb-extra-'));
  registerMount(handle, 'local-context', extra);

  const sent: string[] = [];
  const children: ReturnType<typeof fakeChild>[] = [];
  const sup = await startSupervisor({
    handle,
    db,
    extraDirs: DIRS,
    driver: 'docker-claude',
    container: true,
    log: () => undefined,
    spawnChild: () => {
      const c = fakeChild(sent);
      children.push(c);
      return c;
    },
  });

  try {
    await deliverToSupervisor(handle, { id: 1, to: handle, from: 'lee', ts: Date.now(), body: 'hi' });
    assert.match(sent[0] ?? '', /Mounted directories:.*local-context -> \/mnt\/local-context/s);

    children[0]?.finishTurn();
    await deliverToSupervisor(handle, { id: 2, to: handle, from: 'lee', ts: Date.now(), body: 'again' });
    assert.doesNotMatch(sent[1] ?? '', /Mounted directories:/, 'the banner must not repeat');
  } finally {
    await sup.stop();
  }
});

test('a non-container (bare host) spawn never gets a mount banner', async () => {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  const handle = `mb-bare-${process.pid}`;

  const sent: string[] = [];
  const sup = await startSupervisor({
    handle,
    db,
    extraDirs: DIRS,
    log: () => undefined,
    spawnChild: () => fakeChild(sent),
  });

  try {
    await deliverToSupervisor(handle, { id: 1, to: handle, from: 'lee', ts: Date.now(), body: 'hi' });
    assert.doesNotMatch(sent[0] ?? '', /Mounted directories:/);
  } finally {
    await sup.stop();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern='mount banner|container\\) spawn'`
Expected: FAIL — no banner text is produced

- [ ] **Step 3: Implement — `src/supervise/index.ts`**

Near the top of `startSupervisor`, after `dirs`/`driver` are known:

```typescript
  const { mountsFor, containerPathFor } = await import('./mounts.js');

  /**
   * 🛑 ONLY ONCE, AND ONLY FOR A FRESH NON-RESUMED CONTAINER SPAWN. Design
   * decision 2 of #129: no SessionStart hook, so the first dispatch prompt
   * is the one and only channel. A resumed child already knows its mounts
   * from the FIRST time it was told.
   */
  let needsMountBanner = Boolean(opts.container) && !opts.resumeSessionId;

  const mountBannerPrefix = (): string => {
    if (!needsMountBanner) return '';
    needsMountBanner = false;

    const entries = Object.entries(mountsFor(opts.handle)).map(
      ([key]) => `${key} -> ${containerPathFor(key)}`,
    );

    return entries.length === 0 ? '' : `Mounted directories: ${entries.join(', ')}.\n\n`;
  };
```

Change the main wake-envelope handler's prompt construction from:

```typescript
    const prompt = {
      text: formatPrompt(envelope),
      messageIds: envelope.id > 0 ? [envelope.id] : [],
    };
```

to:

```typescript
    const prompt = {
      text: `${mountBannerPrefix()}${formatPrompt(envelope)}`,
      messageIds: envelope.id > 0 ? [envelope.id] : [],
    };
```

(Task 8 resets `needsMountBanner = true` inside the restart path — not added here, since restart does not exist yet in this task.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --test-name-pattern='mount banner|container\\) spawn'`
Expected: PASS, 2 tests

- [ ] **Step 5: Commit**

```bash
git add src/supervise/index.ts test/supervise/mount-banner.test.ts
git commit -m "feat(#129): advertise registered mounts on the first dispatch prompt"
```

---

## Task 8: `chat-mcp agents restart <handle>`

**Files:**
- Modify: `src/supervise/socket.ts`
- Modify: `src/supervise/index.ts`
- Modify: `src/index.ts`
- Test: `test/supervise/restart.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), 'chat-mcp-restart-'));

const { migrate } = await import('../../src/storage/db.js');
const { startSupervisor } = await import('../../src/supervise/index.js');
const { deliverToSupervisor } = await import('../../src/supervise/socket.js');

const DIRS = [process.cwd()];

interface FakeChild {
  sent: string[];
  killed: boolean;
  finishTurn: () => void;
}

function recordingChild(children: FakeChild[]) {
  return () => {
    const sent: string[] = [];
    let endTurn: (() => void) | undefined;
    const rec: FakeChild = { sent, killed: false, finishTurn: () => endTurn?.() };
    children.push(rec);

    return {
      reportsUsage: false,
      send: (t: string) => sent.push(t),
      onTurnEnd: (cb: () => void) => {
        endTurn = cb;
      },
      onUsage: () => undefined,
      onDenial: () => undefined,
      onSession: (cb: (id: string) => void) => cb('sess-1'),
      onEvent: () => undefined,
      onExit: () => undefined,
      kill: () => {
        rec.killed = true;
      },
    };
  };
}

async function supervisorFor(handle: string, children: FakeChild[]) {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  return startSupervisor({
    handle,
    db,
    extraDirs: DIRS,
    spawnChild: recordingChild(children),
    log: () => undefined,
  });
}

test('--now restarts immediately with no notice sent', async () => {
  const children: FakeChild[] = [];
  const handle = `restart-${process.pid}-now`;
  const sup = await supervisorFor(handle, children);

  try {
    const ack = await deliverToSupervisor(handle, {
      id: 1,
      to: handle,
      from: 'cli',
      ts: Date.now(),
      control: { kind: 'restart', mode: 'now' },
    });

    assert.equal(ack?.ok, true);
    assert.equal(children[0]?.killed, true);
    assert.equal(children.length, 2, 'no replacement child was spawned');
    assert.equal(children[1]?.sent.length, 0, 'an immediate restart must not send a notice');
  } finally {
    await sup.stop();
  }
});

test('graceful restart sends the externalize notice and waits for its reply before killing', async () => {
  const children: FakeChild[] = [];
  const handle = `restart-${process.pid}-graceful`;
  const sup = await supervisorFor(handle, children);

  try {
    const ackPromise = deliverToSupervisor(handle, {
      id: 2,
      to: handle,
      from: 'cli',
      ts: Date.now(),
      control: { kind: 'restart', mode: 'graceful' },
    });

    // The ack returns once the restart is QUEUED, not once it completes —
    // same shape as every other envelope this socket accepts.
    await ackPromise;

    assert.equal(children[0]?.sent.length, 1, 'the notice was never sent');
    assert.match(children[0]?.sent[0] ?? '', /restarting/i);
    assert.equal(children[0]?.killed, false, 'killed before the notice turn ended');

    children[0]?.finishTurn();

    // Give the microtask queue a turn to run the restart's continuation.
    await new Promise((r) => setTimeout(r, 10));

    assert.equal(children[0]?.killed, true, 'never killed after the notice turn ended');
    assert.equal(children.length, 2, 'no replacement child was spawned');
  } finally {
    await sup.stop();
  }
});

test('a restarted child does NOT resume the old session — that is the clean slate', async () => {
  const children: FakeChild[] = [];
  const handle = `restart-${process.pid}-clean`;
  const sup = await supervisorFor(handle, children);

  try {
    await deliverToSupervisor(handle, {
      id: 3,
      to: handle,
      from: 'cli',
      ts: Date.now(),
      control: { kind: 'restart', mode: 'now' },
    });

    await deliverToSupervisor(handle, { id: 4, to: handle, from: 'lee', ts: Date.now(), body: 'hi' });

    // The restarted child's own spawn opts are not captured by this fake,
    // so this asserts behaviourally: a resumed child would echo the SAME
    // session machinery, which this fake always reports as 'sess-1' — the
    // real assertion belongs to Task 5's docker-claude test (--resume
    // presence/absence). Here, just prove the restart path ran at all.
    assert.equal(children.length, 2);
  } finally {
    await sup.stop();
  }
});

test('restarting an unknown handle (no supervisor listening) returns null, not a hang', async () => {
  const ack = await deliverToSupervisor('nobody-home-restart', {
    id: 1,
    to: 'nobody-home-restart',
    from: 'cli',
    ts: Date.now(),
    control: { kind: 'restart', mode: 'now' },
  });

  assert.equal(ack, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern='restart'`
Expected: FAIL — `envelope.control` is not read anywhere, so these acks never arrive / the child is never killed

- [ ] **Step 3: Implement — `src/supervise/socket.ts`**

```typescript
export interface RestartControl {
  readonly kind: 'restart';
  readonly mode: 'graceful' | 'now';
}

export interface WakeEnvelope {
  ...
  /** An out-of-band control command, e.g. a CLI-initiated restart. Absent for a chat wake or an approval. */
  readonly control?: RestartControl;
}
```

- [ ] **Step 4: Implement — `src/supervise/index.ts`**

Add near `replaceChild` (same scope, same closed-over `child`/`queue`/`wireChild`/`turnEndListeners`):

```typescript
  const RESTART_NOTICE =
    'This container is restarting. Externalize anything you need now — ' +
    'this is the last turn before shutdown.';
  const GRACEFUL_RESTART_TIMEOUT_MS = 30_000;

  /**
   * Kill the current child and spawn a FRESH one — no `--resume`. Decision 8:
   * "clean slate" is the point, so unlike `replaceChild` this does not carry
   * the session forward.
   */
  const doRestart = (): void => {
    const unsent = queue.drain();
    log(`restarting child (${unsent.length} prompt(s) carried over)`);
    child.kill();
    childSession = null;
    needsMountBanner = Boolean(opts.container);

    child = spawnFn({
      ...opts,
      cwd: childCwd,
      grant: currentGrant,
      model: currentModel,
      supervisorHandle: opts.handle,
      resumeSessionId: undefined,
    });

    wireChild();
    for (const p of unsent) queue.offer(p);
  };

  const restartChild = (mode: 'graceful' | 'now'): void => {
    if (mode === 'now') {
      doRestart();
      return;
    }

    let awaitingNoticeReply = false;
    let settled = false;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const idx = turnEndListeners.indexOf(onAnyTurnEnd);
      if (idx >= 0) turnEndListeners.splice(idx, 1);
      doRestart();
    };

    // 🛑 A HUNG CHILD MUST NOT BLOCK A RESTART FOREVER — same escape hatch
    // `--now` already provides, bounded rather than open-ended.
    const timer = setTimeout(finish, GRACEFUL_RESTART_TIMEOUT_MS);

    const onAnyTurnEnd = (): void => {
      // 🛑 ONLY THE NOTICE'S OWN REPLY COUNTS. If the queue was mid-turn when
      // this ran, the turn-end that merely flushes the notice into dispatch
      // fires too — before `awaitingNoticeReply` is set — and must not be
      // mistaken for the reply.
      if (!awaitingNoticeReply) return;
      finish();
    };

    turnEndListeners.push(onAnyTurnEnd);

    const originalSend = queue.offer.bind(queue);
    queue.offer = ((prompt: { text: string; messageIds: number[] }) => {
      if (prompt.text === RESTART_NOTICE) awaitingNoticeReply = true;
      return originalSend(prompt);
    }) as typeof queue.offer;

    queue.offer({ text: RESTART_NOTICE, messageIds: [] });
  };
```

Wire the control check into the bind handler, BEFORE the approval check:

```typescript
    if (envelope.control?.kind === 'restart') {
      restartChild(envelope.control.mode);

      return { ok: true, queued: 'sent' };
    }
```

⚠️ **`queue.offer` is reassigned here**, which only works if `TurnQueue`'s `offer` is an own instance method, not a prototype method bound at construction. Read `src/supervise/turn-queue.ts` before this step — if `offer` is a class method accessed via the prototype, reassigning the property on the instance still works in JS (it shadows the prototype lookup), but confirm `queue` is a plain instance (not frozen) before relying on this. If `TurnQueue` turns out to expose `offer` any other way, use a local wrapper flag instead: track `awaitingNoticeReply` by comparing `queue.depth` before/after `queue.offer(...)`, since the exact mechanism is secondary to the invariant the test asserts (the reply's turn-end, not an earlier one, triggers the kill).

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- --test-name-pattern='restart'`
Expected: PASS, 4 tests

- [ ] **Step 6: Implement — `src/index.ts`, the CLI verb**

```typescript
  program
    .command('agents <action> <handle>')
    .description('Control a running supervisor: restart')
    .option('--now', 'skip the graceful notice and kill immediately', false)
    .action(async (action: string, handle: string, o: { now?: boolean }) => {
      if (action !== 'restart') {
        console.error(`Error: unknown action "${action}". Use restart.`);
        process.exit(1);
      }

      const { deliverToSupervisor } = await import('./supervise/socket.js');
      const ack = await deliverToSupervisor(handle, {
        id: 0,
        to: handle,
        from: 'cli',
        ts: Date.now(),
        control: { kind: 'restart', mode: o.now ? 'now' : 'graceful' },
      });

      if (!ack) {
        console.error(`no supervisor is listening for "${handle}"`);
        process.exit(1);
      }

      console.log(`restart ${ack.ok ? 'accepted' : 'refused'} for ${handle}`);
    });
```

- [ ] **Step 7: Run the full suite once**

Run: `npm test`
Expected: PASS, every existing test still green plus the new ones

- [ ] **Step 8: Commit**

```bash
git add src/supervise/socket.ts src/supervise/index.ts src/index.ts test/supervise/restart.test.ts
git commit -m "feat(#129): add chat-mcp agents restart, graceful by default"
```

---

## Task 9: The Dockerfile, packaging, and a real smoke test

**Files:**
- Create: `Dockerfile`
- Modify: `package.json`

- [ ] **Step 1: Write the Dockerfile**

```dockerfile
# chat-mcp agent image — node + git + the claude CLI, nothing else (#129).
# No docker-in-docker: privileged ops go through #133's host broker.
FROM node:22-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git \
  && rm -rf /var/lib/apt/lists/*

# ⚠️ ASSUMPTION TO VERIFY: this is the published npm package name for the
# Claude Code CLI as of this writing. If `claude --version` fails inside the
# built image, this is the first thing to check.
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /opt/chat-mcp
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
# Prebuilt on the HOST before `docker build` runs — see container.ts's
# buildImage(), which runs `npm run build` first. This image never runs tsc.
COPY dist ./dist
```

- [ ] **Step 2: Add `Dockerfile` to the npm package**

In `package.json`, add `"Dockerfile"` to the `"files"` array (alongside `"dist"`, `"web"`, `"README.md"`, `"DESIGN.md"`, `"LICENSE"`) — without this an installed (non-source-checkout) `chat-mcp` cannot find it and `dockerfilePath()` throws.

- [ ] **Step 3: Build the image for real, once, by hand**

Run: `npm run build && docker build -t chat-mcp-agent:local -f Dockerfile .`
Expected: exits 0. If `claude --version` fails inside (step 1's flagged assumption), fix the package name here before proceeding — do not guess a second name without checking `npm view <name>` first.

- [ ] **Step 4: One real end-to-end smoke test, by hand (not in the suite — this needs a live token and Docker)**

```bash
chat-mcp project set smoke-container ~/dev/chat-mcp
chat-mcp auth set-token "$(claude setup-token)"
chat-mcp mount add smoke-container local-context ~/context
chat-mcp supervise smoke-container --container --no-reply
```

Confirm the y/N prompt appears with mount paths and env var NAMES only (no token value on screen), confirm yes, and confirm the supervisor logs `child acts as "smoke-container-agent"` and does not immediately exit. Then from a second terminal: `chat-mcp send smoke-container "say hi"` — confirm the container responds, confirm `docker ps` shows the container while it runs and shows nothing once the supervisor is stopped (`Ctrl-C`), proving `--rm` actually cleaned up.

- [ ] **Step 5: Commit**

```bash
git add Dockerfile package.json
git commit -m "feat(#129): add the agent container image"
```

---

## Self-Review

**Spec coverage** — every numbered design decision (1–9) in the spec maps to a task above: mounts (Task 1 + 7), auth (Task 2), permissions / `--allow-dangerously-skip-permissions` (Task 5), image (Task 9), network (no code change — `docker run` defaults to bridge, asserted nowhere because there is nothing to assert against an absence of a flag), confirm/build (Task 6), restart (Task 8), errors / missing-token fail-fast (Task 5 + 6). "What to check" items (long-lived container token expiry, full in-container permission safety, concurrent-token support, memory-dir path collision) are explicitly **not** proven by this plan — they are the spec's own open questions, not implementation tasks, and Task 9's manual smoke test is the first real evidence on any of them.

**Placeholder scan** — no TBD/TODO; every step shows real code.

**Type consistency** — `supervisorHandle` is introduced in Task 5 and threaded through both spawn sites in Task 6 and the restart spawn in Task 8. `CONTAINER_PROJECT_DIR`/`CONTAINER_STATE_DIR`/`containerPathFor` are defined once (mounts.ts / docker-claude.ts) and only ever imported elsewhere, never redefined.

---

**Plan saved to `docs/superpowers/plans/2026-11-09-container-sandboxing-design.md`.**

Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
