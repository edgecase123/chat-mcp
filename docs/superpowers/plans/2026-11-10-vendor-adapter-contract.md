# Vendor adapter contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make adding a supervised CLI one new file instead of a branch in spawn code.

**Architecture:** One `Adapter` interface carries both wake-hook install and an optional `spawn` block. Sandbox mode (`host` | `docker`) becomes an axis separate from vendor identity, so `docker-claude` stops being a sibling of `claude` and the two drivers collapse into one generic host spawner and one generic container spawner.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node's built-in `node:test`, `tsx` loader, commander for the CLI.

**Spec:** `docs/superpowers/specs/2026-11-10-vendor-adapter-contract-design.md`

---

## Before you start

Run everything from the worktree:

```bash
cd ~/dev/chat-mcp/.worktrees/131-adapter-contract
```

Whole suite:

```bash
npm test
```

One file:

```bash
node --test --experimental-test-module-mocks --import tsx test/adapters/spawn-contract.test.ts
```

One test by name:

```bash
node --test --experimental-test-module-mocks --import tsx --test-name-pattern "exact title" test/path/file.test.ts
```

**Baseline before touching anything: 1025 tests, 0 failures.** If that is not what you see, stop and say so.

### One correction to the spec

The spec sketches `mcpConfigFor: (childHandle, mode) => McpConfig`. The real
call sites need a path, not an object, and the host path comes from the grant
rather than being written at spawn time. This plan uses:

```ts
readonly mcpConfigFor: (grant: ChildGrant, mode: SandboxMode) => string;
```

Flags stay in `argsFor`, because the host and container flag sets differ and
`argsFor` already takes the mode. There is no `McpConfig` type. Task 1 updates
the spec in the same commit so the two documents cannot drift.

---

## File structure

| File | Responsibility |
|---|---|
| `src/adapters/types.ts` | `Adapter`, `VendorSpawn`, `SandboxMode`, `EventRouter`. Types only. |
| `src/adapters/claude-spawn.ts` | NEW. The `VendorSpawn` for Claude Code. The only place Claude's flags live. |
| `src/adapters/index.ts` | registry plus `spawnFor(vendor)` and `vendorsWithSpawn()` |
| `src/supervise/drivers/wiring.ts` | NEW. The child wiring both drivers duplicate today. |
| `src/supervise/drivers/host.ts` | NEW. Generic host spawner. Replaces `spawnClaude`'s process half. |
| `src/supervise/drivers/containerized.ts` | NEW. Generic `docker run` spawner. Replaces `spawnDockerClaude`. |
| `src/supervise/drivers/index.ts` | alias resolution: driver name to (vendor, mode) |
| `src/supervise/drivers/claude.ts` | keeps `claudeArgs`, `writeClaudeMcpConfig`, `routeClaudeEvent`. Loses `spawnClaude`. |
| `src/supervise/drivers/docker-claude.ts` | DELETED in PR 3. Its container-path constants move to `containerized.ts`. |

---

# PR 1 — the interface

No behaviour change. Nothing calls `spawn` yet.

## Task 1: the types

**Files:**
- Modify: `src/adapters/types.ts`
- Modify: `docs/superpowers/specs/2026-11-10-vendor-adapter-contract-design.md`
- Test: `test/adapters/spawn-contract.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `test/adapters/spawn-contract.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listAdapters } from '../../src/adapters/index.js';

test('every adapter declares which vendor CLI it is for', () => {
  for (const adapter of listAdapters()) {
    assert.equal(
      typeof adapter.vendor,
      'string',
      `adapter "${adapter.name}" has no vendor`,
    );
    assert.ok(adapter.vendor.length > 0, `adapter "${adapter.name}" has an empty vendor`);
  }
});

test('🛑 no vendor has two adapters carrying spawn config', () => {
  const owners = new Map<string, string[]>();

  for (const adapter of listAdapters()) {
    if (!adapter.spawn) continue;
    owners.set(adapter.vendor, [...(owners.get(adapter.vendor) ?? []), adapter.name]);
  }

  for (const [vendor, names] of owners) {
    assert.equal(
      names.length,
      1,
      `vendor "${vendor}" has ${names.length} adapters carrying spawn: ${names.join(', ')}`,
    );
  }
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
node --test --experimental-test-module-mocks --import tsx test/adapters/spawn-contract.test.ts
```

Expected: FAIL. The first test reports `adapter "claude-code" has no vendor`, because `vendor` does not exist yet.

- [ ] **Step 3: Add the types**

Replace the body of `src/adapters/types.ts` below `AdapterResult` with:

```ts
/** Where a supervised child runs. */
export type SandboxMode = 'host' | 'docker';

/**
 * Map ONE parsed CLI event onto the supervisor's semantic callbacks.
 *
 * Each vendor writes its own. `routeClaudeEvent` is the Claude Code one.
 */
export type EventRouter = (
  event: Record<string, unknown>,
  on: {
    turnEnd(): void;
    usage(snapshot: RateLimitSnapshot): void;
    denial?(denial: Denial): void;
    session?(id: string): void;
  },
) => void;

/**
 * Everything the supervisor needs in order to spawn one vendor's CLI, in
 * either sandbox mode.
 *
 * 🛑 `argsFor` TAKES THE MODE because the two flag sets are mutually
 * exclusive. The host path passes `--permission-mode` and `--allowedTools`;
 * the container path passes `--allow-dangerously-skip-permissions` and
 * nothing else, because the container boundary is the gate. A vendor owns
 * both sets, so no generic spawner has to know either.
 */
export interface VendorSpawn {
  readonly binary: string;
  readonly image: string;
  /**
   * The container's `HOME`. The bus resolves its state dir from it, so an
   * image whose HOME differs from this value loses the bus silently.
   */
  readonly containerHome: string;
  readonly authEnvVar: string;

  readonly argsFor: (opts: SpawnOptions, mode: SandboxMode) => string[];
  /** The config path to point the CLI at, written first if the mode needs it. */
  readonly mcpConfigFor: (grant: ChildGrant, mode: SandboxMode) => string;
  readonly routeEvent: EventRouter;
  readonly encodeInput: (text: string) => string;
  readonly redispatchPrompt: (input: RedispatchInput) => string;
}

export interface Adapter {
  name: string;
  /** Which CLI this adapter is for. Several adapters may share one vendor. */
  vendor: string;
  description: string;
  scopes: readonly string[];
  defaultScope: string;
  install(opts: AdapterInstallOptions): Promise<AdapterResult>;
  uninstall(opts: AdapterInstallOptions): Promise<AdapterResult>;
  /**
   * Present on at most ONE adapter per vendor, asserted by
   * `test/adapters/spawn-contract.test.ts`. A wake-only adapter omits it.
   */
  spawn?: VendorSpawn;
}
```

Add these imports at the top of the same file:

```ts
import type { SpawnOptions } from '../supervise/child.js';
import type { ChildGrant } from '../supervise/grant.js';
import type { Denial } from '../supervise/denial.js';
import type { RateLimitSnapshot } from '../supervise/rate-limit.js';
import type { RedispatchInput } from '../supervise/drivers/claude-redispatch.js';
```

⚠️ `ChildGrant` is exported from `supervise/grant.ts`, NOT from
`supervise/child.ts`. `child.ts` only re-imports it.

Then add `vendor: 'claude',` to the adapter object at the bottom of
`src/adapters/claude-code.ts` and of `src/adapters/claude-code-context.ts`.
Neither gets a `spawn` yet.

- [ ] **Step 4: Run the test and watch it pass**

```bash
node --test --experimental-test-module-mocks --import tsx test/adapters/spawn-contract.test.ts
```

Expected: PASS, 2 tests. The second test passes vacuously right now — no adapter carries `spawn`. Task 3 makes it meaningful.

- [ ] **Step 5: Prove the guard is not vacuous**

Temporarily add `spawn: {} as never,` to BOTH adapter objects, then run the
same command.

Expected: FAIL with `vendor "claude" has 2 adapters carrying spawn: claude-code, claude-code-context`.

Remove both temporary lines. Re-run and confirm PASS. **Do not commit the temporary lines.**

- [ ] **Step 6: Reconcile the spec**

In `docs/superpowers/specs/2026-11-10-vendor-adapter-contract-design.md`, change

```
  readonly mcpConfigFor: (childHandle: string, mode: SandboxMode) => McpConfig;
```

to

```
  readonly mcpConfigFor: (grant: ChildGrant, mode: SandboxMode) => string;
```

and delete `McpConfig` from the "two new types" sentence if one is present.

- [ ] **Step 7: Typecheck and commit**

```bash
npx tsc --noEmit
git add src/adapters/types.ts src/adapters/claude-code.ts src/adapters/claude-code-context.ts test/adapters/spawn-contract.test.ts docs/superpowers/specs/2026-11-10-vendor-adapter-contract-design.md
git commit -m "feat(#131): an adapter could not say which CLI it was for

Adds vendor and an optional spawn block to the Adapter interface, plus a
guard asserting no vendor has two adapters carrying spawn config.

Refs #131"
```

## Task 2: the Claude VendorSpawn

**Files:**
- Create: `src/adapters/claude-spawn.ts`
- Test: `test/adapters/claude-spawn.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `test/adapters/claude-spawn.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeSpawn } from '../../src/adapters/claude-spawn.js';

test('host mode passes the permission flags, never the container bypass', () => {
  const args = claudeSpawn.argsFor({}, 'host');

  assert.ok(args.includes('--permission-mode'));
  assert.ok(!args.includes('--allow-dangerously-skip-permissions'));
});

test('🛑 docker mode passes the bypass and NONE of the host permission flags', () => {
  const args = claudeSpawn.argsFor({}, 'docker');

  assert.ok(args.includes('--allow-dangerously-skip-permissions'));
  // Decision 4: the two sets are mutually exclusive. A container child that
  // also got --permission-mode would be gated twice and stall.
  assert.ok(!args.includes('--permission-mode'));
  assert.ok(!args.includes('--allowedTools'));
  assert.ok(!args.includes('--tools'));
});

test('both modes keep --verbose, which stream-json requires', () => {
  for (const mode of ['host', 'docker'] as const) {
    assert.ok(claudeSpawn.argsFor({}, mode).includes('--verbose'), `${mode} dropped --verbose`);
  }
});

test('the stdin envelope is one JSON user message per line', () => {
  const line = claudeSpawn.encodeInput('ping');

  assert.equal(line.at(-1), '\n');
  assert.deepEqual(JSON.parse(line), {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: 'ping' }] },
  });
});

test('the container HOME matches the state dir the bus resolves in-container', () => {
  // The in-container bus reads $HOME/.chat-mcp with no env var set, so these
  // two values are one fact written twice. A mismatch loses the bus silently.
  assert.equal(claudeSpawn.containerHome, '/root');
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
node --test --experimental-test-module-mocks --import tsx test/adapters/claude-spawn.test.ts
```

Expected: FAIL, `Cannot find module .../claude-spawn.js`.

- [ ] **Step 3: Write the implementation**

Create `src/adapters/claude-spawn.ts`:

```ts
import type { ChildGrant, SpawnOptions } from '../supervise/child.js';
import type { SandboxMode, VendorSpawn } from './types.js';
import { claudeArgs, routeClaudeEvent } from '../supervise/drivers/claude.js';
import { redispatchPrompt } from '../supervise/drivers/claude-redispatch.js';
import { IMAGE_TAG } from '../supervise/container.js';
import { writeContainerMcpConfig } from '../supervise/drivers/docker-claude.js';

/**
 * Claude Code's spawn contract: the only place this CLI's flag names live.
 *
 * The host flag set is `claudeArgs`, unchanged and still exported from the
 * driver so its existing tests keep passing. The container set is smaller on
 * purpose — decision 4 of the #129 spec gives a contained child full
 * in-container permissions, because the container is the boundary.
 */
function containerArgs(opts: SpawnOptions): string[] {
  const args = [
    '-p',
    '--verbose',
    '--output-format',
    'stream-json',
    '--input-format',
    'stream-json',
    '--allow-dangerously-skip-permissions',
  ];

  if (opts.model) args.push('--model', opts.model);
  if (opts.resumeSessionId) args.push('--resume', opts.resumeSessionId);

  return args;
}

export const claudeSpawn: VendorSpawn = {
  binary: 'claude',
  image: IMAGE_TAG,
  containerHome: '/root',
  authEnvVar: 'CLAUDE_CODE_OAUTH_TOKEN',

  argsFor: (opts: SpawnOptions, mode: SandboxMode): string[] =>
    mode === 'docker' ? containerArgs(opts) : claudeArgs(opts),

  // Host: the grant already holds a host-side path, written at grant time.
  // Docker: the file is rewritten with container-side command and args, and
  // the path the CLI is given is the one that exists INSIDE the container.
  mcpConfigFor: (grant: ChildGrant, mode: SandboxMode): string =>
    mode === 'docker' ? writeContainerMcpConfig(grant.handle) : grant.configPath,

  routeEvent: routeClaudeEvent,

  encodeInput: (text: string): string =>
    `${JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
    })}\n`,

  redispatchPrompt,
};
```

`writeContainerMcpConfig` is currently a private function in
`src/supervise/drivers/docker-claude.ts`. Export it by adding `export` to its
declaration on line 37. Nothing else about that file changes in PR 1.

- [ ] **Step 4: Run the test and watch it pass**

```bash
node --test --experimental-test-module-mocks --import tsx test/adapters/claude-spawn.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Typecheck, run the whole suite, commit**

```bash
npx tsc --noEmit
npm test
```

Expected: 1030 tests, 0 failures (1025 plus the 2 from Task 1 and 5 here, minus nothing).
If the total differs, read the failure before adjusting the number — the count is a check, not a target.

```bash
git add src/adapters/claude-spawn.ts src/supervise/drivers/docker-claude.ts test/adapters/claude-spawn.test.ts
git commit -m "feat(#131): Claude Code's flag names lived in two spawn paths

Collects them into one VendorSpawn, with the host and container flag sets
side by side so their mutual exclusivity is visible in one file.

Refs #131"
```

## Task 3: attach it and resolve by vendor

**Files:**
- Modify: `src/adapters/claude-code.ts` (the exported adapter object, near line 291)
- Modify: `src/adapters/index.ts`
- Test: `test/adapters/spawn-contract.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Append to `test/adapters/spawn-contract.test.ts`:

```ts
import { spawnFor, vendorsWithSpawn } from '../../src/adapters/index.js';

test('spawnFor resolves the claude vendor to a spawn block', () => {
  assert.equal(spawnFor('claude').binary, 'claude');
});

test('🛑 spawnFor throws and names what exists, rather than falling back', () => {
  // A silent fallback to claude would mean asking for cursor and getting
  // claude, which looks exactly like cursor working.
  assert.throws(() => spawnFor('cursor'), /cursor/);
  assert.throws(() => spawnFor('cursor'), /claude/);
});

test('vendorsWithSpawn lists every vendor that can be spawned', () => {
  assert.deepEqual([...vendorsWithSpawn()].sort(), ['claude']);
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
node --test --experimental-test-module-mocks --import tsx test/adapters/spawn-contract.test.ts
```

Expected: FAIL, `spawnFor is not a function`.

- [ ] **Step 3: Implement**

In `src/adapters/claude-code.ts`, import the spawn block and attach it:

```ts
import { claudeSpawn } from './claude-spawn.js';
```

and add `spawn: claudeSpawn,` to the exported adapter object, beside the
`vendor: 'claude',` added in Task 1. Leave `claude-code-context.ts` without a
`spawn` — that is what the guard from Task 1 is protecting.

Append to `src/adapters/index.ts`:

```ts
import type { VendorSpawn } from './types.js';

/** Every vendor this build can spawn. */
export function vendorsWithSpawn(): readonly string[] {
  return [...new Set(REGISTRY.filter((a) => a.spawn).map((a) => a.vendor))];
}

/**
 * The spawn contract for `vendor`.
 *
 * 🛑 THROWS, AND NAMES WHAT IS AVAILABLE, for the same reason `driverFor`
 * does: a silent fallback would make a missing vendor look like a working one.
 */
export function spawnFor(vendor: string): VendorSpawn {
  const found = REGISTRY.find((a) => a.vendor === vendor && a.spawn)?.spawn;

  if (!found) {
    throw new Error(
      `vendor "${vendor}" cannot be spawned by this build; it has: ${vendorsWithSpawn().join(', ')}`,
    );
  }

  return found;
}
```

- [ ] **Step 4: Run the test and watch it pass**

```bash
node --test --experimental-test-module-mocks --import tsx test/adapters/spawn-contract.test.ts
```

Expected: PASS, 5 tests. The no-two-spawns guard is now non-vacuous, because exactly one adapter carries `spawn`.

- [ ] **Step 5: Typecheck, full suite, commit**

```bash
npx tsc --noEmit && npm test
git add src/adapters/claude-code.ts src/adapters/index.ts test/adapters/spawn-contract.test.ts
git commit -m "feat(#131): nothing could look up how to spawn a given CLI

Adds spawnFor(vendor), which throws and names the available vendors rather
than falling back to claude.

Refs #131"
```

## Task 4: open PR 1

- [ ] **Step 1: Push**

```bash
git push -u origin 131-adapter-contract
```

- [ ] **Step 2: Request review in `#mcp` BEFORE anything long-running**

The review request goes out at push time, not at PR time.

- [ ] **Step 3: Open the PR**

Title: `feat(#131): an adapter could not say which CLI it was for, or how to spawn it`

Body must state: no behaviour change, nothing calls `spawn` yet, and that the
no-two-spawns guard was proved non-vacuous by temporarily adding a second
`spawn` (Task 1 Step 5). Use `Refs #131`, not `Closes`, because PRs 2 and 3
are still to come.

---

# PR 2 — extract the duplicated wiring

Pure move. Behaviour identical.

## Task 5: `wiring.ts`

**Files:**
- Create: `src/supervise/drivers/wiring.ts`
- Test: `test/supervise/drivers/wiring.test.ts` (create)

Measured on the current tree, 60 of the container driver's 65 non-blank wiring
lines are identical to the host driver's — `docker-claude.ts:110-179` against
`claude.ts:240-326`, ignoring indentation. This task is that overlap, once.

- [ ] **Step 1: Write the failing test**

Create `test/supervise/drivers/wiring.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { wireAgentChild } from '../../../src/supervise/drivers/wiring.js';
import { routeClaudeEvent } from '../../../src/supervise/drivers/claude.js';

function fakeProcess() {
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  const exitCbs: ((code: number | null, signal: string | null) => void)[] = [];

  return {
    stdout,
    stdin,
    on(event: string, cb: (code: number | null, signal: string | null) => void) {
      if (event === 'exit') exitCbs.push(cb);
    },
    kill() {
      for (const cb of exitCbs) cb(null, 'SIGTERM');
    },
  };
}

test('a turn-end event reaches every onTurnEnd subscriber', async () => {
  const proc = fakeProcess();
  const agent = wireAgentChild(proc as never, {
    routeEvent: routeClaudeEvent,
    encodeInput: (t) => `${t}\n`,
  });

  let ends = 0;
  agent.onTurnEnd(() => {
    ends += 1;
  });
  agent.onTurnEnd(() => {
    ends += 1;
  });

  proc.stdout.write(`${JSON.stringify({ type: 'result' })}\n`);
  await new Promise((r) => setImmediate(r));

  assert.equal(ends, 2);
});

test('🛑 a LATE onSession subscriber still receives an id that already arrived', async () => {
  // A subscriber registered after the system init event would otherwise never
  // learn the session id, which is what makes a grant resumable.
  const proc = fakeProcess();
  const agent = wireAgentChild(proc as never, {
    routeEvent: routeClaudeEvent,
    encodeInput: (t) => `${t}\n`,
  });

  proc.stdout.write(`${JSON.stringify({ type: 'system', session_id: 'abc' })}\n`);
  await new Promise((r) => setImmediate(r));

  let seen: string | null = null;
  agent.onSession((id) => {
    seen = id;
  });

  assert.equal(seen, 'abc');
});

test('the same session id is reported once, not on every event that repeats it', async () => {
  const proc = fakeProcess();
  const agent = wireAgentChild(proc as never, {
    routeEvent: routeClaudeEvent,
    encodeInput: (t) => `${t}\n`,
  });

  const ids: string[] = [];
  agent.onSession((id) => ids.push(id));

  proc.stdout.write(`${JSON.stringify({ type: 'system', session_id: 'abc' })}\n`);
  proc.stdout.write(`${JSON.stringify({ type: 'assistant', session_id: 'abc' })}\n`);
  await new Promise((r) => setImmediate(r));

  assert.deepEqual(ids, ['abc']);
});

test('send writes the vendor envelope to stdin', () => {
  const proc = fakeProcess();
  const written: string[] = [];
  proc.stdin.on('data', (c: Buffer) => written.push(c.toString()));

  const agent = wireAgentChild(proc as never, {
    routeEvent: routeClaudeEvent,
    encodeInput: (t) => `ENVELOPE:${t}\n`,
  });

  agent.send('ping');

  assert.deepEqual(written, ['ENVELOPE:ping\n']);
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
node --test --experimental-test-module-mocks --import tsx test/supervise/drivers/wiring.test.ts
```

Expected: FAIL, `Cannot find module .../wiring.js`.

- [ ] **Step 3: Write `wiring.ts`**

```ts
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AgentChild } from '../child.js';
import { createLineParser } from '../child.js';
import type { RateLimitSnapshot } from '../rate-limit.js';
import type { Denial } from '../denial.js';
import type { EventRouter } from '../../adapters/types.js';

/**
 * Turn a spawned process into an `AgentChild`.
 *
 * 🛑 THIS EXISTED TWICE. The host driver and the container driver carried the
 * same callback arrays, the same line parser and the same six subscribe
 * methods, differing only in the event router and the stdin envelope — both
 * of which are now arguments. Keeping one copy is what makes a third vendor a
 * file rather than a third copy.
 */
export function wireAgentChild(
  child: ChildProcessWithoutNullStreams,
  vendor: { routeEvent: EventRouter; encodeInput: (text: string) => string },
): AgentChild {
  const eventCbs: ((e: Record<string, unknown>) => void)[] = [];
  const turnEndCbs: (() => void)[] = [];
  const usageCbs: ((s: RateLimitSnapshot) => void)[] = [];
  const denialCbs: ((d: Denial) => void)[] = [];
  const sessionCbs: ((id: string) => void)[] = [];
  let lastSession: string | null = null;

  const feed = createLineParser((parsed) => {
    for (const cb of eventCbs) cb(parsed);

    vendor.routeEvent(parsed, {
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
        // Only the FIRST sighting matters; every later event repeats it.
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
      child.stdin.write(vendor.encodeInput(text));
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
      // A late subscriber must not miss an id that already arrived.
      if (lastSession) cb(lastSession);
    },
    onEvent(cb): void {
      eventCbs.push(cb);
    },
    onExit(cb): void {
      child.on('exit', (code, signal) => cb(code, signal));
    },
    kill(): void {
      child.kill();
    },
  };
}
```

- [ ] **Step 4: Run the test and watch it pass**

```bash
node --test --experimental-test-module-mocks --import tsx test/supervise/drivers/wiring.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
npx tsc --noEmit
git add src/supervise/drivers/wiring.ts test/supervise/drivers/wiring.test.ts
git commit -m "refactor(#131): the child wiring existed twice, 60 of 65 lines identical

Extracts it once, with the event router and the stdin envelope as arguments
— the only two things the two copies actually disagreed on.

Refs #131"
```

## Task 6: both drivers use it

**Files:**
- Modify: `src/supervise/drivers/claude.ts:252-326`
- Modify: `src/supervise/drivers/docker-claude.ts:107-179`

- [ ] **Step 1: Replace `spawnClaude`'s body**

In `src/supervise/drivers/claude.ts`, replace everything from `const eventCbs`
through the final `};` of `spawnClaude` with:

```ts
  return wireAgentChild(child, { routeEvent: routeClaudeEvent, encodeInput: claudeEncodeInput });
```

Add at the top of the file:

```ts
import { wireAgentChild } from './wiring.js';
```

and, above `spawnClaude`:

```ts
/** The documented streaming-input shape: one JSON user message per line. */
export function claudeEncodeInput(text: string): string {
  return `${JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
  })}\n`;
}
```

Then change `src/adapters/claude-spawn.ts` to use it instead of its own inline
copy, so the envelope exists once:

```ts
import { claudeArgs, claudeEncodeInput, routeClaudeEvent } from '../supervise/drivers/claude.js';
```

and `encodeInput: claudeEncodeInput,` in the `claudeSpawn` object.

- [ ] **Step 2: Do the same in `docker-claude.ts`**

Replace everything from `const eventCbs` through the final `};` of
`spawnDockerClaude` with:

```ts
  return wireAgentChild(child, { routeEvent: routeClaudeEvent, encodeInput: claudeEncodeInput });
```

Update its imports: add `wireAgentChild` from `./wiring.js` and
`claudeEncodeInput` from `./claude.js`. Remove the now-unused imports of
`createLineParser`, `RateLimitSnapshot` and `Denial`.

- [ ] **Step 3: Run the whole suite**

```bash
npx tsc --noEmit && npm test
```

Expected: 0 failures. The `kill()` test from #139 still passes, because
`wireAgentChild` keeps `child.kill()`.

- [ ] **Step 4: Prove the move changed nothing observable**

```bash
git stash
npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)" > /tmp/before.txt
git stash pop
npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)" > /tmp/after.txt
diff /tmp/before.txt /tmp/after.txt
```

Expected: no output from `diff`. Same test count, same pass count. A pure move
must not change either.

- [ ] **Step 5: Commit, push, request review, open PR 2**

```bash
git add src/supervise/drivers/claude.ts src/supervise/drivers/docker-claude.ts src/adapters/claude-spawn.ts
git commit -m "refactor(#131): both drivers now share the one copy of the child wiring

Refs #131"
git push
```

Title: `refactor(#131): the child wiring existed twice, 60 of 65 lines identical`

Body must include the before/after test-count diff from Step 4 as the evidence
that a pure move stayed pure.

---

# PR 3 — collapse the drivers

This is the one that can break spawning. The equivalence tests come first, on
purpose, so they describe today's behaviour rather than the new code's.

## Task 7: lock in today's argv, before changing anything

**Files:**
- Test: `test/supervise/drivers/equivalence.test.ts` (create)

- [ ] **Step 1: Write the test against the CURRENT code**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), 'chat-mcp-equivalence-'));

const { setToken } = await import('../../../src/supervise/auth.js');
const { dockerArgsFor } = await import('../../../src/supervise/drivers/docker-claude.js');
const { claudeArgs } = await import('../../../src/supervise/drivers/claude.js');
const { claudeSpawn } = await import('../../../src/adapters/claude-spawn.js');

const PROJECT_DIR = join(process.env.CHAT_MCP_HOME, 'project');
mkdirSync(PROJECT_DIR, { recursive: true });

test('the adapter host argv equals the host driver argv today', () => {
  const opts = { cwd: PROJECT_DIR, model: 'opus', supervisorHandle: 'claude1' };

  assert.deepEqual(claudeSpawn.argsFor(opts, 'host'), claudeArgs(opts));
});

test('🛑 the adapter docker argv equals the CLI tail of dockerArgsFor today', () => {
  setToken('sk-ant-oat-x');
  const opts = { cwd: PROJECT_DIR, model: 'opus', supervisorHandle: 'claude1' };

  const full = dockerArgsFor(opts);
  // Everything after the image tag is the CLI invocation; everything before it
  // is docker's own argv. Splitting on the binary name is what makes this
  // comparison about the CLI flags and not about the mounts.
  const cliTail = full.slice(full.indexOf('claude') + 1);

  assert.deepEqual(claudeSpawn.argsFor(opts, 'docker'), cliTail);
});
```

- [ ] **Step 2: Run it**

```bash
node --test --experimental-test-module-mocks --import tsx test/supervise/drivers/equivalence.test.ts
```

Expected: PASS, 2 tests. **If either fails, STOP.** A failure here means Task 2
got a flag wrong, and every later task would inherit it. Fix
`claude-spawn.ts` until both pass before continuing.

- [ ] **Step 3: Commit**

```bash
git add test/supervise/drivers/equivalence.test.ts
git commit -m "test(#131): pin the current spawn argv before collapsing the drivers

Refs #131"
```

## Task 8: the two generic spawners

**Files:**
- Create: `src/supervise/drivers/host.ts`
- Create: `src/supervise/drivers/containerized.ts`

- [ ] **Step 1: Write `host.ts`**

```ts
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AgentChild, SpawnOptions } from '../child.js';
import type { VendorSpawn } from '../../adapters/types.js';
import { wireAgentChild } from './wiring.js';

/** Spawn a vendor's CLI as a bare host process. */
export function spawnOnHost(vendor: VendorSpawn, opts: SpawnOptions = {}): AgentChild {
  const child: ChildProcessWithoutNullStreams = spawn(
    opts.binary ?? vendor.binary,
    vendor.argsFor(opts, 'host'),
    { cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'] },
  ) as ChildProcessWithoutNullStreams;

  return wireAgentChild(child, vendor);
}
```

- [ ] **Step 2: Write `containerized.ts`**

This is `docker-claude.ts`'s `dockerArgsFor` with every Claude-specific value
replaced by a `vendor` field. The mount loop, `--rm`, `-i` and the working
directory are unchanged.

```ts
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AgentChild, SpawnOptions } from '../child.js';
import type { VendorSpawn } from '../../adapters/types.js';
import { wireAgentChild } from './wiring.js';
import { mountsFor, containerPathFor } from '../mounts.js';
import { readToken } from '../auth.js';
import { stateDir } from '../../util/paths.js';

export const CONTAINER_PROJECT_DIR = '/work';

export { containerPathFor };

/** Where the bus's state dir lands inside the container, for this vendor. */
export function containerStateDir(vendor: VendorSpawn): string {
  return `${vendor.containerHome}/.chat-mcp`;
}

export function dockerArgsForVendor(vendor: VendorSpawn, opts: SpawnOptions): string[] {
  const token = readToken();
  if (!token) {
    throw new Error(
      'no Claude OAuth token on file; run `claude setup-token` on the host, then ' +
        '`chat-mcp auth set-token <token>`',
    );
  }

  if (!opts.supervisorHandle) {
    throw new Error('a containerized spawn needs opts.supervisorHandle to find its mounts');
  }

  const projectDir = opts.cwd;
  if (!projectDir) {
    throw new Error('a containerized spawn needs a resolved cwd');
  }

  const args = [
    'run',
    '-i',
    '--rm',
    '-e',
    `${vendor.authEnvVar}=${token}`,
    '-v',
    `${projectDir}:${CONTAINER_PROJECT_DIR}`,
    '-v',
    `${stateDir()}:${containerStateDir(vendor)}`,
  ];

  for (const [key, hostDir] of Object.entries(mountsFor(opts.supervisorHandle))) {
    args.push('-v', `${hostDir}:${containerPathFor(key)}`);
  }

  args.push('-w', CONTAINER_PROJECT_DIR, vendor.image);
  args.push(vendor.binary, ...vendor.argsFor(opts, 'docker'));

  if (opts.grant) {
    args.push('--mcp-config', vendor.mcpConfigFor(opts.grant, 'docker'), '--strict-mcp-config');
  }

  return args;
}

/**
 * Spawn a vendor's CLI inside `docker run`.
 *
 * 🛑 ONE `docker run` PROCESS, DRIVEN OVER STDIN AND STDOUT. No `docker exec`,
 * ever — decision 8 of the #129 spec.
 */
export function spawnContainerized(vendor: VendorSpawn, opts: SpawnOptions = {}): AgentChild {
  const child: ChildProcessWithoutNullStreams = spawn(
    'docker',
    dockerArgsForVendor(vendor, opts),
    { stdio: ['pipe', 'pipe', 'pipe'] },
  ) as ChildProcessWithoutNullStreams;

  return wireAgentChild(child, vendor);
}
```

- [ ] **Step 3: Extend the equivalence test to cover the new spawners**

Append to `test/supervise/drivers/equivalence.test.ts`:

```ts
const { dockerArgsForVendor } = await import('../../../src/supervise/drivers/containerized.js');

test('🛑 the generic container argv is byte-identical to dockerArgsFor today', () => {
  setToken('sk-ant-oat-x');
  const opts = { cwd: PROJECT_DIR, model: 'opus', supervisorHandle: 'claude1' };

  assert.deepEqual(dockerArgsForVendor(claudeSpawn, opts), dockerArgsFor(opts));
});
```

- [ ] **Step 4: Run it**

```bash
node --test --experimental-test-module-mocks --import tsx test/supervise/drivers/equivalence.test.ts
```

Expected: PASS, 3 tests. This is the test that proves the collapse is safe. If
the deepEqual fails, read the diff it prints — it names the exact argv position
that drifted.

- [ ] **Step 5: Commit**

```bash
npx tsc --noEmit && npm test
git add src/supervise/drivers/host.ts src/supervise/drivers/containerized.ts test/supervise/drivers/equivalence.test.ts
git commit -m "feat(#131): the container spawner hardcoded one vendor's image, env var and binary

Adds generic host and container spawners that read all three from the
vendor's spawn block, pinned byte-identical to the old argv.

Refs #131"
```

## Task 9: alias resolution, and the gate reads the mode

**Files:**
- Modify: `src/supervise/drivers/index.ts`
- Modify: `src/index.ts:425` and `src/index.ts:384-418`
- Delete: `src/supervise/drivers/docker-claude.ts`
- Test: `test/supervise/drivers/aliases.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDriver } from '../../../src/supervise/drivers/index.js';

test('the published driver names keep working', () => {
  assert.deepEqual(resolveDriver({ driver: 'claude' }), { vendor: 'claude', mode: 'host' });
  assert.deepEqual(resolveDriver({ driver: 'docker-claude' }), { vendor: 'claude', mode: 'docker' });
});

test('--container with no --driver means the docker mode of the default vendor', () => {
  assert.deepEqual(resolveDriver({ container: true }), { vendor: 'claude', mode: 'docker' });
});

test('🛑 a vendor name plus --container needs no new alias', () => {
  // This is the whole point of #131: a second CLI is a file, not a branch.
  assert.deepEqual(resolveDriver({ driver: 'cursor', container: true }), {
    vendor: 'cursor',
    mode: 'docker',
  });
});

test('neither flag means the host mode of the default vendor', () => {
  assert.deepEqual(resolveDriver({}), { vendor: 'claude', mode: 'host' });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
node --test --experimental-test-module-mocks --import tsx test/supervise/drivers/aliases.test.ts
```

Expected: FAIL, `resolveDriver is not a function`.

- [ ] **Step 3: Replace `src/supervise/drivers/index.ts`**

```ts
import type { AgentChild, SpawnOptions } from '../child.js';
import type { SandboxMode } from '../../adapters/types.js';
import { spawnFor } from '../../adapters/index.js';
import { spawnOnHost } from './host.js';
import { spawnContainerized } from './containerized.js';
import type { RedispatchInput } from './claude-redispatch.js';

/**
 * How a CLI name and a `--container` flag become a spawner.
 *
 * 🛑 SANDBOX MODE IS AN AXIS, NOT A VENDOR. `docker-claude` used to be a
 * sibling of `claude` in this registry, so a second CLI meant two entries and
 * a pairing nobody could see. It is now an alias over (vendor, mode), which is
 * also why the confirm gate can read `mode === 'docker'` instead of matching a
 * driver-name string a new vendor would spell differently.
 */
const ALIASES: Record<string, { vendor: string; mode: SandboxMode }> = {
  claude: { vendor: 'claude', mode: 'host' },
  'docker-claude': { vendor: 'claude', mode: 'docker' },
};

const DEFAULT_VENDOR = 'claude';

export interface DriverSelection {
  readonly vendor: string;
  readonly mode: SandboxMode;
}

export function resolveDriver(o: { driver?: string; container?: boolean }): DriverSelection {
  const mode: SandboxMode = o.container ? 'docker' : 'host';

  if (!o.driver) return { vendor: DEFAULT_VENDOR, mode };

  const alias = ALIASES[o.driver];
  // An alias names its own mode. `--container` can only tighten it, never
  // loosen it, so an explicit `--driver docker-claude` stays containerized.
  if (alias) return { vendor: alias.vendor, mode: alias.mode === 'docker' ? 'docker' : mode };

  return { vendor: o.driver, mode };
}

export function spawnWith(selection: DriverSelection, opts: SpawnOptions = {}): AgentChild {
  const vendor = spawnFor(selection.vendor);

  return selection.mode === 'docker'
    ? spawnContainerized(vendor, opts)
    : spawnOnHost(vendor, opts);
}

export function redispatchFor(selection: DriverSelection): (input: RedispatchInput) => string {
  return spawnFor(selection.vendor).redispatchPrompt;
}
```

- [ ] **Step 4: Run the alias test and watch it pass**

```bash
node --test --experimental-test-module-mocks --import tsx test/supervise/drivers/aliases.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Update the supervisor and the CLI**

In `src/supervise/index.ts`, replace the `driverFor(...)` call with
`resolveDriver({ driver: opts.driver, container: opts.container })` held as one
`selection`, then use `spawnWith(selection, …)` and
`redispatchFor(selection)`. Replace the existing container gate — the
`opts.container || opts.driver === 'docker-claude'` expression — with
`selection.mode === 'docker'`.

In `src/index.ts`, line 425, delete the driver default:

```ts
driver: o.driver,
```

The `o.driver ?? (o.container ? 'docker-claude' : 'claude')` expression goes
away, because `resolveDriver` now owns that decision and its tests cover all
four combinations.

In the same file's confirm block (lines 384-418), source the vendor values from
the adapter instead of writing them inline:

```ts
const { spawnFor } = await import('./adapters/index.js');
const { containerStateDir } = await import('./supervise/drivers/containerized.js');
const vendor = spawnFor(resolveDriver({ driver: o.driver, container: true }).vendor);
```

then in `describePlan`:

```ts
mountPaths: ['/work', containerStateDir(vendor), ...extra],
envVarNames: [vendor.authEnvVar],
binary: vendor.binary,
```

- [ ] **Step 6: Delete the old driver and move its test**

```bash
git rm src/supervise/drivers/docker-claude.ts
```

`test/supervise/drivers/docker-claude.test.ts` must be retargeted, not
deleted. Change its imports from `docker-claude.js` to `containerized.js`,
replace `dockerArgsFor(opts)` with `dockerArgsForVendor(claudeSpawn, opts)`
and `spawnDockerClaude(opts)` with `spawnContainerized(claudeSpawn, opts)`.
Rename the file to `containerized.test.ts`. **Keep the mid-turn `kill()` test
from #139 exactly as it is** apart from those renames — it is the only proof
that stopping a contained agent works.

`test/supervise/drivers/equivalence.test.ts` imports `dockerArgsFor` from the
deleted file. Its job was to pin the old behaviour during the move, and that
job is finished. Delete that file in this commit and say so in the PR body.

- [ ] **Step 7: Full suite**

```bash
npx tsc --noEmit && npm test
```

Expected: 0 failures.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(#131): adding a CLI meant two registry entries and a pairing nobody could see

Collapses the two drivers into a generic host spawner and a generic
container spawner, with --driver values kept as aliases over (vendor, mode).
The container confirm gate now reads the mode rather than matching a
driver-name string, which is what both #137 reviewers flagged.

Refs #131"
```

## Task 10: prove the container is actually removed

The one thing #139 could not test. It belongs here, because `kill()` now lives
in `containerized.ts`.

**Files:**
- Test: `test/supervise/drivers/container-removal.test.ts` (create)

- [ ] **Step 1: Write the test, skipped when Docker is absent**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';

function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

test(
  '🛑 killing the docker-run process removes the --rm container',
  { skip: dockerAvailable() ? false : 'docker is not available here' },
  async () => {
    const name = `chat-mcp-removal-${process.pid}`;
    const child = spawn('docker', ['run', '-i', '--rm', '--name', name, 'alpine', 'sleep', '300']);

    // Wait for the container to actually exist before killing it, otherwise a
    // pass could mean "it never started".
    await new Promise((resolve, reject) => {
      const started = Date.now();
      const poll = setInterval(() => {
        const out = execFileSync('docker', ['ps', '-q', '-f', `name=${name}`]).toString().trim();
        if (out) {
          clearInterval(poll);
          resolve(undefined);
        } else if (Date.now() - started > 20000) {
          clearInterval(poll);
          reject(new Error('container never started'));
        }
      }, 200);
    });

    child.kill();
    await new Promise((resolve) => child.on('exit', resolve));

    // `--rm` removal is asynchronous, so poll rather than reading once.
    const gone = await new Promise<boolean>((resolve) => {
      const started = Date.now();
      const poll = setInterval(() => {
        const out = execFileSync('docker', ['ps', '-a', '-q', '-f', `name=${name}`])
          .toString()
          .trim();
        if (!out) {
          clearInterval(poll);
          resolve(true);
        } else if (Date.now() - started > 20000) {
          clearInterval(poll);
          resolve(false);
        }
      }, 300);
    });

    assert.ok(gone, `container ${name} was still listed by docker ps -a after kill()`);
  },
);
```

- [ ] **Step 2: Run it with Docker up**

```bash
node --test --experimental-test-module-mocks --import tsx test/supervise/drivers/container-removal.test.ts
```

Expected: PASS. If Docker is not running, expected: skipped with the reason printed.

- [ ] **Step 3: Prove it can fail**

Change `child.kill()` to `// child.kill()`, re-run.

Expected: FAIL with `container chat-mcp-removal-NNN was still listed by docker ps -a after kill()`.

Restore the line. Re-run and confirm PASS. **A skipped run does not count as a pass for this step** — if Docker is unavailable, say so and leave the step unchecked rather than claiming it.

- [ ] **Step 4: Narrow the comment in `containerized.ts`**

`kill()` lives in `wiring.ts` now, and `containerized.ts`'s header carries the
decision-8 note. Add one line to that header stating that removal is proved by
`container-removal.test.ts`, and remove any wording that says removal is only
manually verified.

- [ ] **Step 5: Commit, push, request review, open PR 3**

```bash
npx tsc --noEmit && npm test
git add -A
git commit -m "test(#131): nothing automated proved --rm actually removes the container

Refs #131"
git push
```

Title: `feat(#131): adding a supervised CLI meant a branch in spawn code`

Body must state:
- the equivalence test that pinned the argv, and that it was deleted once the move landed
- that `docker-claude.test.ts` was retargeted rather than deleted, including #139's `kill()` test
- that the container-removal test is Docker-gated and whether it actually ran
- `Closes #131`

---

## Self-review notes

Checked against the spec, section by section.

| spec section | task |
|---|---|
| one interface, `spawn` optional | 1 |
| `vendor` field and why | 1 |
| `VendorSpawn` fields | 1, 2 |
| `argsFor` takes a mode | 2, and the mutual-exclusivity test in Task 2 Step 1 |
| `image` / `containerHome` / `authEnvVar` not hardcoded | 8 |
| `wiring.ts` and the measured duplication | 5, 6 |
| CLI alias table, all five rows | 9 Step 1 — four tests covering the four input shapes |
| `requiresContainer` retired | 9 Step 5 |
| guard test, one `spawn` per vendor | 1, proved non-vacuous in Step 5 |
| guard test, every adapter has a vendor | 1 |
| equivalence tests | 7, 8 |
| gate test reached by mode | 9 Step 5 |
| container removal | 10 |
| out of scope: Cursor adapter, per-vendor `builtHash` | not planned, deliberately |

One deviation from the spec, recorded in "Before you start" and fixed in the
spec itself by Task 1 Step 6: `mcpConfigFor` returns a path, not an
`McpConfig`, and there is no `McpConfig` type.
