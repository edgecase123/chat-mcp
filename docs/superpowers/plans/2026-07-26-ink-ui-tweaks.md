# Ink UI Tweaks — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Ink UI polish spec — slash autocomplete, argument completion, Ctrl-K command palette, context-aware hint bar, rooms discoverability (sidebar shape B + `/rooms` browser), formatted `/help`, empty-state guidance, readline-style input editing, and number-key sidebar jumps.

**Architecture:** Split the single 770-line `App.tsx` into focused component files under `src/cli/ink/`. Introduce a canonical command catalogue (`commands.ts`) that Autocomplete, Palette, and HelpPane all read. Replace `ink-text-input` with a hand-rolled `Input.tsx` to gain per-key control. Pure-logic modules (`commands.ts`, `fuzzy.ts`, `completions.ts`) get real unit tests via Node's built-in `node:test`; UI components get manual smoke via the CLI subprocess.

**Tech Stack:** TypeScript, React 19, Ink 7, `node:sqlite`, `node:test` (built-in, Node ≥22.5).

**Spec:** `docs/superpowers/specs/2026-07-26-ink-ui-tweaks-design.md`

---

## File plan

Created:

- `src/cli/ink/commands.ts` — canonical command catalogue (name, args, description, category, arg-completion source)
- `src/cli/ink/fuzzy.ts` — subsequence fuzzy match utility
- `src/cli/ink/views.ts` — `View` type union (extracted from `App.tsx`)
- `src/cli/ink/input/Input.tsx` — hand-rolled text input
- `src/cli/ink/input/Autocomplete.tsx` — dropdown for slash + arg completions
- `src/cli/ink/input/completions.ts` — pure completion engine
- `src/cli/ink/palette/Palette.tsx` — Ctrl-K overlay
- `src/cli/ink/panes/Header.tsx` — extracted
- `src/cli/ink/panes/AlertLane.tsx` — extracted
- `src/cli/ink/panes/Sidebar.tsx` — extracted + shape-B rewrite
- `src/cli/ink/panes/MessagesPane.tsx` — extracted
- `src/cli/ink/panes/WhoPane.tsx` — extracted
- `src/cli/ink/panes/HelpPane.tsx` — new
- `src/cli/ink/panes/RoomsBrowserPane.tsx` — new
- `src/cli/ink/panes/EmptyState.tsx` — new
- `src/cli/ink/HintBar.tsx` — new
- `test/cli/ink/commands.test.ts`
- `test/cli/ink/fuzzy.test.ts`
- `test/cli/ink/input/completions.test.ts`

Modified:

- `src/cli/ink/App.tsx` — reduced to layout + top-level state + keyboard routing
- `src/cli/ink/index.ts` — no functional change unless entry needs adjustment
- `package.json` — remove `ink-text-input` dep; add `test` script; bump version
- `tsconfig.json` — include `test/**/*` for typecheck (if not already)

Deleted (from `package.json` `dependencies`):

- `ink-text-input`

---

## Task 1: Test scaffolding (node:test)

**Files:**
- Create: `test/README.md`
- Modify: `package.json`
- Modify: `tsconfig.json` (only if needed)

- [ ] **Step 1: Verify Node version supports `node:test`**

```bash
node --version
```

Expected: `v22.5.0` or higher (per `package.json` engines).

- [ ] **Step 2: Add `test` npm script**

Modify `package.json` `scripts` (leave other keys untouched):

```json
"scripts": {
  "build": "tsc",
  "dev": "tsx src/index.ts",
  "clean": "rm -rf dist",
  "smoke": "npm run build && node scripts/smoke.mjs",
  "test": "node --test --import tsx",
  "prepare": "npm run build"
}
```

Node ≥22.5's `--test` without file args auto-discovers `test/**/*.test.*`.

- [ ] **Step 3: Create `test/README.md`**

```markdown
# Tests

`node:test` (built into Node ≥22.5) runs `test/**/*.test.ts` via `tsx`.

```bash
npm test                                # all
node --test --import tsx test/cli/ink/fuzzy.test.ts   # one file
```

Pure-logic modules only. UI components smoked via `npm run smoke` and manual `npm run dev -- cli --experimental --handle testuser`.
```

- [ ] **Step 4: Sanity-check `tsconfig.json` picks up `test/`**

Read `tsconfig.json`. If `include` is present and excludes `test/`, add it:

```json
"include": ["src/**/*", "test/**/*"]
```

If `include` is absent, tsc picks up everything by default — no change needed.

- [ ] **Step 5: Add a smoke test to prove the harness works**

Create `test/harness.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('harness runs', () => {
  assert.equal(1 + 1, 2);
});
```

Run: `npm test`

Expected: `tests 1`, `pass 1`, `fail 0`.

- [ ] **Step 6: Commit**

```bash
git add package.json test/README.md test/harness.test.ts tsconfig.json
git commit -m "test: add node:test harness for pure-logic unit tests"
```

---

## Task 2: Command catalogue (`commands.ts`)

**Files:**
- Create: `src/cli/ink/commands.ts`
- Create: `test/cli/ink/commands.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/cli/ink/commands.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMMANDS, CATEGORIES, findCommand } from '../../../src/cli/ink/commands.js';

test('every command has a category, description, and name', () => {
  for (const c of COMMANDS) {
    assert.match(c.name, /^\/[a-z-]+$/, `${c.name} shape`);
    assert.ok(c.description.length > 0, `${c.name} description`);
    assert.ok(CATEGORIES.includes(c.category), `${c.name} category valid`);
  }
});

test('command names are unique', () => {
  const names = COMMANDS.map((c) => c.name);
  assert.equal(new Set(names).size, names.length);
});

test('findCommand resolves by exact name', () => {
  assert.equal(findCommand('/dm')?.name, '/dm');
  assert.equal(findCommand('/nope'), undefined);
});

test('every existing command from App.tsx doCommand is present', () => {
  const expected = [
    '/quit', '/exit', '/help', '/back', '/rooms', '/who', '/dm', '/join',
    '/leave', '/set-status', '/dispatch', '/broadcast', '/alert',
    '/watch', '/unwatch', '/ack',
  ];
  for (const name of expected) {
    assert.ok(findCommand(name), `missing ${name}`);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`

Expected: FAIL — `COMMANDS` not found.

- [ ] **Step 3: Create `src/cli/ink/commands.ts`**

```typescript
export type Category = 'conversation' | 'messaging' | 'status' | 'system';

export const CATEGORIES: Category[] = ['conversation', 'messaging', 'status', 'system'];

export const CATEGORY_LABELS: Record<Category, string> = {
  conversation: 'CONVERSATION',
  messaging: 'MESSAGING',
  status: 'STATUS & OBSERVATION',
  system: 'SYSTEM',
};

export type ArgKind = 'peer' | 'room' | 'target' | 'status' | 'text' | 'none';

export interface CommandArg {
  name: string;
  kind: ArgKind;
  optional?: boolean;
  variadic?: boolean;
}

export interface Command {
  name: string;
  args: CommandArg[];
  description: string;
  category: Category;
}

export const COMMANDS: Command[] = [
  { name: '/dm', args: [{ name: 'peer', kind: 'peer' }], description: 'open a DM', category: 'conversation' },
  { name: '/join', args: [{ name: '#room', kind: 'room' }], description: 'join a room', category: 'conversation' },
  { name: '/leave', args: [], description: 'leave current room', category: 'conversation' },
  { name: '/back', args: [], description: 'return to home', category: 'conversation' },
  { name: '/rooms', args: [], description: 'open room browser', category: 'conversation' },

  { name: '/dispatch', args: [{ name: 'peer', kind: 'peer' }, { name: 'text', kind: 'text', variadic: true }], description: 'send tagged [DISPATCH] to peer', category: 'messaging' },
  { name: '/broadcast', args: [{ name: '#room', kind: 'room' }, { name: 'text', kind: 'text', variadic: true }], description: 'send tagged [DISPATCH] to room', category: 'messaging' },
  { name: '/alert', args: [{ name: 'target', kind: 'target' }, { name: 'text', kind: 'text', variadic: true }], description: 'urgent — red banner', category: 'messaging' },
  { name: '/ack', args: [], description: 'dismiss visible alerts', category: 'messaging' },

  { name: '/set-status', args: [{ name: 'status', kind: 'status' }, { name: 'focus', kind: 'text', variadic: true, optional: true }], description: 'set your status + focus', category: 'status' },
  { name: '/who', args: [], description: 'peer table', category: 'status' },
  { name: '/watch', args: [{ name: 'peer', kind: 'peer' }], description: 'mirror another peer\'s traffic', category: 'status' },
  { name: '/unwatch', args: [], description: 'close watch pane', category: 'status' },

  { name: '/help', args: [], description: 'open this help', category: 'system' },
  { name: '/quit', args: [], description: 'quit', category: 'system' },
  { name: '/exit', args: [], description: 'quit', category: 'system' },
];

export function findCommand(name: string): Command | undefined {
  return COMMANDS.find((c) => c.name === name);
}

export function commandsByCategory(cat: Category): Command[] {
  return COMMANDS.filter((c) => c.category === cat);
}

export function argShape(cmd: Command): string {
  return cmd.args
    .map((a) => (a.optional ? `[${a.name}${a.variadic ? '...' : ''}]` : `<${a.name}${a.variadic ? '...' : ''}>`))
    .join(' ');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`

Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/cli/ink/commands.ts test/cli/ink/commands.test.ts
git commit -m "feat(ink): canonical command catalogue"
```

---

## Task 3: Fuzzy subsequence match (`fuzzy.ts`)

**Files:**
- Create: `src/cli/ink/fuzzy.ts`
- Create: `test/cli/ink/fuzzy.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/cli/ink/fuzzy.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fuzzyMatch, fuzzyFilter } from '../../../src/cli/ink/fuzzy.js';

test('empty query matches everything', () => {
  assert.equal(fuzzyMatch('', 'anything'), true);
});

test('exact prefix matches', () => {
  assert.equal(fuzzyMatch('dm', '/dm'), true);
});

test('subsequence match', () => {
  assert.equal(fuzzyMatch('dsp', '/dispatch'), true);
  assert.equal(fuzzyMatch('brd', '/broadcast'), true);
});

test('missing letters do not match', () => {
  assert.equal(fuzzyMatch('xyz', '/dispatch'), false);
});

test('case-insensitive', () => {
  assert.equal(fuzzyMatch('DM', '/dm'), true);
  assert.equal(fuzzyMatch('dm', '/DM'), true);
});

test('fuzzyFilter returns matches in input order', () => {
  const items = ['/dm', '/dispatch', '/join', '/broadcast'];
  const result = fuzzyFilter('d', items, (s) => s);
  assert.deepEqual(result, ['/dm', '/dispatch', '/broadcast']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`

Expected: FAIL — `fuzzyMatch` not found.

- [ ] **Step 3: Create `src/cli/ink/fuzzy.ts`**

```typescript
/**
 * Case-insensitive subsequence match. Every character of `needle` must
 * appear in `haystack` in order (not necessarily contiguously).
 */
export function fuzzyMatch(needle: string, haystack: string): boolean {
  if (needle.length === 0) return true;
  const n = needle.toLowerCase();
  const h = haystack.toLowerCase();
  let hi = 0;
  for (let ni = 0; ni < n.length; ni++) {
    while (hi < h.length && h[hi] !== n[ni]) hi++;
    if (hi >= h.length) return false;
    hi++;
  }
  return true;
}

/** Return items whose key matches `needle`, preserving input order. */
export function fuzzyFilter<T>(needle: string, items: T[], key: (t: T) => string): T[] {
  return items.filter((t) => fuzzyMatch(needle, key(t)));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`

Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/cli/ink/fuzzy.ts test/cli/ink/fuzzy.test.ts
git commit -m "feat(ink): subsequence fuzzy match utility"
```

---

## Task 4: Completion engine (`completions.ts`)

**Files:**
- Create: `src/cli/ink/input/completions.ts`
- Create: `test/cli/ink/input/completions.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/cli/ink/input/completions.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getCompletions } from '../../../../src/cli/ink/input/completions.js';

const ctx = {
  me: 'claude2',
  peers: ['claude1', 'pclaude', 'lee'],
  memberRooms: ['#leagues', '#gate'],
  discoverRooms: ['#planning', '#deploy'],
};

test('empty input returns no completions', () => {
  assert.deepEqual(getCompletions('', 0, ctx), []);
});

test('non-slash input returns no completions', () => {
  assert.deepEqual(getCompletions('hello', 5, ctx), []);
});

test('typing "/d" suggests /dm and /dispatch', () => {
  const c = getCompletions('/d', 2, ctx);
  const names = c.map((x) => x.value);
  assert.ok(names.includes('/dm'));
  assert.ok(names.includes('/dispatch'));
  assert.ok(!names.includes('/join'));
});

test('typing "/dm cla" suggests claude1 (not self, not #room)', () => {
  const c = getCompletions('/dm cla', 7, ctx);
  const names = c.map((x) => x.value);
  assert.deepEqual(names, ['claude1']);
});

test('typing "/dm " with no prefix suggests all peers except self', () => {
  const c = getCompletions('/dm ', 4, ctx);
  const names = c.map((x) => x.value);
  assert.deepEqual(names, ['claude1', 'pclaude', 'lee']);
});

test('typing "/join #le" suggests un-joined rooms only', () => {
  const c = getCompletions('/join #le', 9, ctx);
  const names = c.map((x) => x.value);
  assert.deepEqual(names, []); // #leagues is already joined; no others match "le"
});

test('typing "/join #p" suggests #planning', () => {
  const c = getCompletions('/join #p', 8, ctx);
  const names = c.map((x) => x.value);
  assert.deepEqual(names, ['#planning']);
});

test('typing "/broadcast #g" suggests joined rooms only', () => {
  const c = getCompletions('/broadcast #g', 13, ctx);
  const names = c.map((x) => x.value);
  assert.deepEqual(names, ['#gate']);
});

test('typing "/alert #le" (room mode) suggests joined rooms only', () => {
  const c = getCompletions('/alert #le', 10, ctx);
  const names = c.map((x) => x.value);
  assert.deepEqual(names, ['#leagues']);
});

test('typing "/alert cla" (peer mode) suggests peers only', () => {
  const c = getCompletions('/alert cla', 10, ctx);
  const names = c.map((x) => x.value);
  assert.deepEqual(names, ['claude1']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`

Expected: FAIL — `getCompletions` not found.

- [ ] **Step 3: Create `src/cli/ink/input/completions.ts`**

```typescript
import { COMMANDS, findCommand } from '../commands.js';
import type { Command } from '../commands.js';

export interface CompletionCtx {
  me: string;
  peers: string[];
  memberRooms: string[];
  discoverRooms: string[];
}

export interface Completion {
  value: string;        // text to insert (command name or arg value)
  display?: string;     // optional label; falls back to value
  description?: string; // shown dim after the value
  kind: 'command' | 'peer' | 'room';
}

/**
 * Compute completions for the current input + cursor position.
 * Contract:
 * - Input must begin with `/`; else returns [].
 * - When cursor is on the command token, matches command names by prefix.
 * - When cursor is inside an argument, matches per the command's arg kind.
 */
export function getCompletions(input: string, cursor: number, ctx: CompletionCtx): Completion[] {
  if (!input.startsWith('/')) return [];
  const beforeCursor = input.slice(0, cursor);
  const tokens = beforeCursor.split(/\s+/);
  // Command token itself (index 0)
  if (tokens.length === 1) {
    const prefix = tokens[0]!.toLowerCase();
    return COMMANDS.filter((c) => c.name.toLowerCase().startsWith(prefix)).map((c) => ({
      value: c.name,
      description: c.description,
      kind: 'command',
    }));
  }

  const cmd = findCommand(tokens[0]!);
  if (!cmd) return [];

  const argIndex = tokens.length - 2; // -1 for command token itself; then convert to arg index
  const argToken = tokens[tokens.length - 1] ?? '';
  const arg = cmd.args[argIndex];
  if (!arg) return [];

  const lower = argToken.toLowerCase();

  switch (arg.kind) {
    case 'peer':
      return ctx.peers
        .filter((p) => p !== ctx.me && p.toLowerCase().startsWith(lower))
        .map((p) => ({ value: p, kind: 'peer' }));
    case 'room': {
      const source = cmd.name === '/join' ? ctx.discoverRooms : ctx.memberRooms;
      return source
        .filter((r) => r.toLowerCase().startsWith(lower))
        .map((r) => ({ value: r, kind: 'room' }));
    }
    case 'target': {
      // /alert accepts either a peer or a joined room. Disambiguate by
      // the current token's leading '#'.
      if (argToken.startsWith('#')) {
        return ctx.memberRooms
          .filter((r) => r.toLowerCase().startsWith(lower))
          .map((r) => ({ value: r, kind: 'room' }));
      }
      return ctx.peers
        .filter((p) => p !== ctx.me && p.toLowerCase().startsWith(lower))
        .map((p) => ({ value: p, kind: 'peer' }));
    }
    case 'status':
    case 'text':
    case 'none':
      return [];
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`

Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add src/cli/ink/input/completions.ts test/cli/ink/input/completions.test.ts
git commit -m "feat(ink): pure completion engine for slash + arg completion"
```

---

## Task 5: Extract `views.ts` (type union)

**Files:**
- Create: `src/cli/ink/views.ts`
- Modify: `src/cli/ink/App.tsx`

- [ ] **Step 1: Create `src/cli/ink/views.ts`**

```typescript
export type View =
  | { kind: 'home' }
  | { kind: 'dm'; peer: string }
  | { kind: 'room'; room: string }
  | { kind: 'who' }
  | { kind: 'help' }
  | { kind: 'rooms' };
```

- [ ] **Step 2: Replace the inline `View` definition in `App.tsx`**

In `src/cli/ink/App.tsx`, remove lines 17–21 (the `type View = ...` block) and add at the top:

```typescript
import type { View } from './views.js';
```

- [ ] **Step 3: Build**

Run: `npm run build`

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/cli/ink/views.ts src/cli/ink/App.tsx
git commit -m "refactor(ink): extract View type union to views.ts"
```

---

## Task 6: Extract `Header.tsx`

**Files:**
- Create: `src/cli/ink/panes/Header.tsx`
- Modify: `src/cli/ink/App.tsx`

- [ ] **Step 1: Create `src/cli/ink/panes/Header.tsx`**

```typescript
import React from 'react';
import { Box, Text } from 'ink';
import type { AgentStatus } from '../../../storage/dao.js';

const STATUS_COLOR: Record<AgentStatus, string> = {
  idle: 'green',
  thinking: 'yellow',
  tool: 'cyan',
  blocked: 'red',
  error: 'red',
  offline: 'gray',
};

export interface HeaderProps {
  handle: string;
  version: string;
  status: AgentStatus | null;
  focus: string | null;
}

export function Header({ handle, version, status, focus }: HeaderProps): React.ReactElement {
  return (
    <Box borderStyle="round" borderColor="gray" paddingX={1}>
      <Text>
        <Text bold>chat-mcp</Text>{' '}
        <Text dimColor>v{version}-ink</Text> ·{' '}
        <Text color="cyan">{handle}</Text>
        {status && (
          <>
            {' '}· <Text color={STATUS_COLOR[status]}>●</Text> <Text>{status}</Text>
            {focus && (
              <>
                {' '}
                <Text dimColor>({focus})</Text>
              </>
            )}
          </>
        )}{' '}
        <Text dimColor>· /help · Ctrl-C</Text>
      </Text>
    </Box>
  );
}
```

- [ ] **Step 2: Replace inline header markup in `App.tsx`**

In `App.tsx`, delete only the `{/* Header */}` block (lines ~446–466). **Do NOT remove the local `STATUS_COLOR` const yet** — Sidebar (still inline in App.tsx) uses it. STATUS_COLOR is removed in Task 9 alongside the Sidebar extraction.

Import and render:

```typescript
import { Header } from './panes/Header.js';

// inside return():
<Header handle={handle} version={version} status={meStatus} focus={meFocus} />
```

- [ ] **Step 3: Build + manual smoke**

Run: `npm run build && node dist/index.js cli --experimental --handle testuser`

Expected: header renders identically to before (handle, version, status dot). Ctrl-C to exit.

- [ ] **Step 4: Commit**

```bash
git add src/cli/ink/panes/Header.tsx src/cli/ink/App.tsx
git commit -m "refactor(ink): extract Header component"
```

---

## Task 7: Extract `AlertLane.tsx`

**Files:**
- Create: `src/cli/ink/panes/AlertLane.tsx`
- Modify: `src/cli/ink/App.tsx`

- [ ] **Step 1: Create `src/cli/ink/panes/AlertLane.tsx`**

```typescript
import React from 'react';
import { Box, Text } from 'ink';

export interface Alert {
  id: number;
  from: string;
  to: string;
  body: string;
  ts: number;
}

function timeOf(ts: number): string {
  return new Date(ts).toTimeString().slice(0, 8);
}

export function AlertLane({ alerts }: { alerts: Alert[] }): React.ReactElement | null {
  if (alerts.length === 0) return null;
  return (
    <Box borderStyle="round" borderColor="red" paddingX={1} flexDirection="column">
      {alerts.map((a) => (
        <Text key={a.id}>
          <Text color="red" bold>🚨 ALERT</Text>{' '}
          <Text color="green" bold>{a.from}</Text>{' '}
          <Text dimColor>→ {a.to} · {timeOf(a.ts)}</Text>{' '}
          <Text>{a.body}</Text>
        </Text>
      ))}
      <Text dimColor>(/ack to dismiss)</Text>
    </Box>
  );
}
```

- [ ] **Step 2: Replace inline alert-lane markup in `App.tsx`**

Remove the `{alerts.length > 0 && (...)}` block (~lines 469–485). Remove the local `Alert` interface and inline `timeOf` if now unused elsewhere. Import + render:

```typescript
import { AlertLane } from './panes/AlertLane.js';
import type { Alert } from './panes/AlertLane.js';

// inside return():
<AlertLane alerts={alerts} />
```

- [ ] **Step 3: Build + smoke**

Run: `npm run build && node dist/index.js cli --experimental --handle testuser`

Expected: no visible change. If alerts exist (send one via a sibling shim), lane renders red.

- [ ] **Step 4: Commit**

```bash
git add src/cli/ink/panes/AlertLane.tsx src/cli/ink/App.tsx
git commit -m "refactor(ink): extract AlertLane component"
```

---

## Task 8: Extract `MessagesPane.tsx` + `WhoPane.tsx`

**Files:**
- Create: `src/cli/ink/panes/MessagesPane.tsx`
- Create: `src/cli/ink/panes/WhoPane.tsx`
- Modify: `src/cli/ink/App.tsx`

- [ ] **Step 1: Create `src/cli/ink/panes/MessagesPane.tsx`**

Copy the existing `MessagesPane` function (App.tsx ~649–691), its interface, and the `KIND_LABEL` / `KIND_COLOR` constants (~44–54). Adjust imports:

```typescript
import React from 'react';
import { Box, Text } from 'ink';
import type { Message, MessageKind } from '../../../storage/dao.js';
import type { View } from '../views.js';

const KIND_LABEL: Record<MessageKind, string | null> = { chat: null, dispatch: 'DISPATCH', alert: 'ALERT' };
const KIND_COLOR: Record<MessageKind, string | undefined> = { chat: undefined, dispatch: 'cyan', alert: 'red' };

function timeOf(ts: number): string {
  return new Date(ts).toTimeString().slice(0, 8);
}

interface MessagesPaneProps {
  view: View;
  messages: Message[];
  meHandle: string;
}

export function MessagesPane({ view, messages, meHandle }: MessagesPaneProps): React.ReactElement {
  // …copy body verbatim from App.tsx…
}
```

Preserve the exact function body.

- [ ] **Step 2: Create `src/cli/ink/panes/WhoPane.tsx`**

Copy the existing `WhoPane` function (App.tsx ~718–770) plus `WHO_COLUMNS`, `Column`, `pad` helpers (~698–716). Adjust imports:

```typescript
import React from 'react';
import { Box, Text } from 'ink';
import type { Agent, AgentStatus } from '../../../storage/dao.js';

const STATUS_COLOR: Record<AgentStatus, string> = { idle: 'green', thinking: 'yellow', tool: 'cyan', blocked: 'red', error: 'red', offline: 'gray' };

function timeOf(ts: number): string {
  return new Date(ts).toTimeString().slice(0, 8);
}

// …copy Column, WHO_COLUMNS, pad, WhoPane verbatim…
```

- [ ] **Step 3: Delete extracted code from `App.tsx`**

Remove `MessagesPane`, `WhoPane`, `Column`, `WHO_COLUMNS`, `pad`, `KIND_LABEL`, `KIND_COLOR` from App.tsx. Add imports:

```typescript
import { MessagesPane } from './panes/MessagesPane.js';
import { WhoPane } from './panes/WhoPane.js';
```

- [ ] **Step 4: Build + smoke**

Run: `npm run build && node dist/index.js cli --experimental --handle testuser`

Expected: `/who` still renders the peer table; DMs still render messages.

- [ ] **Step 5: Commit**

```bash
git add src/cli/ink/panes/MessagesPane.tsx src/cli/ink/panes/WhoPane.tsx src/cli/ink/App.tsx
git commit -m "refactor(ink): extract MessagesPane + WhoPane"
```

---

## Task 9: Extract `Sidebar.tsx` (current shape, no behaviour change yet)

**Files:**
- Create: `src/cli/ink/panes/Sidebar.tsx`
- Modify: `src/cli/ink/App.tsx`

- [ ] **Step 1: Create `src/cli/ink/panes/Sidebar.tsx`**

Copy the existing `Sidebar` function (App.tsx ~558–641) and `SidebarProps` interface. Imports:

```typescript
import React from 'react';
import { Box, Text } from 'ink';
import type { Agent, AgentStatus } from '../../../storage/dao.js';
import type * as dao from '../../../storage/dao.js';
import type { View } from '../views.js';

const STATUS_COLOR: Record<AgentStatus, string> = { idle: 'green', thinking: 'yellow', tool: 'cyan', blocked: 'red', error: 'red', offline: 'gray' };

export interface SidebarProps {
  handle: string;
  view: View;
  peers: Agent[];
  rooms: ReturnType<typeof dao.myRooms>;
  dmUnreadByPeer: Map<string, number>;
  roomUnreadByName: Map<string, number>;
}

export function Sidebar(props: SidebarProps): React.ReactElement {
  // …copy body verbatim…
}
```

- [ ] **Step 2: Delete `Sidebar` from `App.tsx`; add import**

Delete the `Sidebar` function + `SidebarProps` interface. Also delete the local `STATUS_COLOR` const (no longer used in App.tsx after Sidebar leaves; verify with `grep -n 'STATUS_COLOR' src/cli/ink/App.tsx` — should return no results). Add:

```typescript
import { Sidebar } from './panes/Sidebar.js';
```

- [ ] **Step 3: Build + smoke**

Run: `npm run build && node dist/index.js cli --experimental --handle testuser`

Expected: sidebar renders identically to before.

- [ ] **Step 4: Commit**

```bash
git add src/cli/ink/panes/Sidebar.tsx src/cli/ink/App.tsx
git commit -m "refactor(ink): extract Sidebar component"
```

---

## Task 10: Hand-rolled `Input.tsx`

**Files:**
- Create: `src/cli/ink/input/Input.tsx`

- [ ] **Step 1: Create `src/cli/ink/input/Input.tsx`**

```typescript
import React from 'react';
import { Box, Text, useInput } from 'ink';

export interface InputProps {
  value: string;
  cursor: number; // 0..value.length
  onChange: (value: string, cursor: number) => void;
  onSubmit: (value: string) => void;
  onTab?: () => void;
  onEsc?: () => void;
  onUp?: () => void;
  onDown?: () => void;
  prompt?: string;
}

function isWordChar(ch: string): boolean {
  return /[a-zA-Z0-9_]/.test(ch);
}

function prevWordBoundary(s: string, cursor: number): number {
  let i = cursor;
  while (i > 0 && !isWordChar(s[i - 1]!)) i--;
  while (i > 0 && isWordChar(s[i - 1]!)) i--;
  return i;
}

function nextWordBoundary(s: string, cursor: number): number {
  let i = cursor;
  while (i < s.length && !isWordChar(s[i]!)) i++;
  while (i < s.length && isWordChar(s[i]!)) i++;
  return i;
}

export function Input({
  value,
  cursor,
  onChange,
  onSubmit,
  onTab,
  onEsc,
  onUp,
  onDown,
  prompt = '> ',
}: InputProps): React.ReactElement {
  useInput((raw, key) => {
    if (key.return) return onSubmit(value);
    if (key.tab) return onTab?.();
    if (key.escape) return onEsc?.();
    if (key.upArrow) return onUp?.();
    if (key.downArrow) return onDown?.();

    if (key.leftArrow) {
      if (key.meta) {
        return onChange(value, prevWordBoundary(value, cursor));
      }
      return onChange(value, Math.max(0, cursor - 1));
    }
    if (key.rightArrow) {
      if (key.meta) {
        return onChange(value, nextWordBoundary(value, cursor));
      }
      return onChange(value, Math.min(value.length, cursor + 1));
    }

    if (key.ctrl && raw === 'a') return onChange(value, 0);
    if (key.ctrl && raw === 'e') return onChange(value, value.length);
    if (key.ctrl && raw === 'u') return onChange(value.slice(cursor), 0);
    if (key.ctrl && raw === 'w') {
      const start = prevWordBoundary(value, cursor);
      return onChange(value.slice(0, start) + value.slice(cursor), start);
    }
    if (key.meta && raw === 'd') {
      const end = nextWordBoundary(value, cursor);
      return onChange(value.slice(0, cursor) + value.slice(end), cursor);
    }

    if (key.backspace || key.delete) {
      // Note: on macOS the Delete key sends key.backspace; the fn-Delete
      // (forward delete) sends key.delete. Opt-Backspace sends key.meta + key.backspace.
      if (key.meta && key.backspace) {
        const start = prevWordBoundary(value, cursor);
        return onChange(value.slice(0, start) + value.slice(cursor), start);
      }
      if (key.backspace) {
        if (cursor === 0) return;
        return onChange(value.slice(0, cursor - 1) + value.slice(cursor), cursor - 1);
      }
      if (key.delete) {
        if (cursor === value.length) return;
        return onChange(value.slice(0, cursor) + value.slice(cursor + 1), cursor);
      }
    }

    // Printable insert. Ink hands us `raw` as the pasted/typed string.
    if (raw && !key.ctrl && !key.meta) {
      const next = value.slice(0, cursor) + raw + value.slice(cursor);
      return onChange(next, cursor + raw.length);
    }
  });

  const before = value.slice(0, cursor);
  const at = value[cursor] ?? ' ';
  const after = value.slice(cursor + 1);
  return (
    <Box>
      <Text color="cyan">{prompt}</Text>
      <Text>{before}</Text>
      <Text inverse>{at}</Text>
      <Text>{after}</Text>
    </Box>
  );
}
```

- [ ] **Step 2: Build**

Run: `npm run build`

Expected: no errors. (No wire-up in App.tsx yet — that comes in Task 15.)

- [ ] **Step 3: Commit**

```bash
git add src/cli/ink/input/Input.tsx
git commit -m "feat(ink): hand-rolled Input with readline-style keybindings"
```

---

## Task 11: `Autocomplete.tsx`

**Files:**
- Create: `src/cli/ink/input/Autocomplete.tsx`

- [ ] **Step 1: Create `src/cli/ink/input/Autocomplete.tsx`**

```typescript
import React from 'react';
import { Box, Text } from 'ink';
import type { Completion } from './completions.js';

export interface AutocompleteProps {
  completions: Completion[];
  selectedIndex: number;
  maxRows?: number;
}

export function Autocomplete({ completions, selectedIndex, maxRows = 6 }: AutocompleteProps): React.ReactElement | null {
  if (completions.length === 0) return null;
  const visible = completions.slice(0, maxRows);
  return (
    <Box borderStyle="round" borderColor="cyan" flexDirection="column" paddingX={1}>
      {visible.map((c, i) => {
        const active = i === selectedIndex;
        return (
          <Text key={c.value + i}>
            {active ? <Text color="cyan">▸ </Text> : <Text>  </Text>}
            <Text bold={active} color={active ? 'cyan' : undefined}>{c.display ?? c.value}</Text>
            {c.description && (
              <>
                {'  '}
                <Text dimColor>— {c.description}</Text>
              </>
            )}
          </Text>
        );
      })}
      {completions.length > maxRows && (
        <Text dimColor>… {completions.length - maxRows} more</Text>
      )}
    </Box>
  );
}
```

- [ ] **Step 2: Build**

Run: `npm run build`

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/cli/ink/input/Autocomplete.tsx
git commit -m "feat(ink): Autocomplete dropdown component"
```

---

## Task 12: `Palette.tsx`

**Files:**
- Create: `src/cli/ink/palette/Palette.tsx`

- [ ] **Step 1: Create `src/cli/ink/palette/Palette.tsx`**

```typescript
import React, { useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { COMMANDS, argShape } from '../commands.js';
import type { Command } from '../commands.js';
import { fuzzyFilter } from '../fuzzy.js';

export interface PaletteProps {
  onSelect: (cmd: Command) => void;
  onClose: () => void;
}

export function Palette({ onSelect, onClose }: PaletteProps): React.ReactElement {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const matches = useMemo(
    () => fuzzyFilter(query, COMMANDS, (c) => `${c.name} ${c.description}`),
    [query],
  );

  useInput((raw, key) => {
    if (key.escape) return onClose();
    if (key.return) {
      const pick = matches[selected];
      if (pick) onSelect(pick);
      return;
    }
    if (key.upArrow) return setSelected((i) => Math.max(0, i - 1));
    if (key.downArrow) return setSelected((i) => Math.min(matches.length - 1, i + 1));
    if (key.backspace) {
      setQuery((q) => q.slice(0, -1));
      setSelected(0);
      return;
    }
    if (raw && !key.ctrl && !key.meta) {
      setQuery((q) => q + raw);
      setSelected(0);
    }
  });

  const visible = matches.slice(0, 8);

  return (
    <Box borderStyle="round" borderColor="magenta" flexDirection="column" paddingX={1}>
      <Text color="magenta" bold>⌘K COMMANDS</Text>
      <Box>
        <Text>🔍 </Text>
        <Text>{query}</Text>
        <Text inverse> </Text>
      </Box>
      {visible.length === 0 ? (
        <Text dimColor>(no matches)</Text>
      ) : (
        visible.map((c, i) => {
          const active = i === selected;
          return (
            <Text key={c.name}>
              {active ? <Text color="magenta">▸ </Text> : <Text>  </Text>}
              <Text bold={active} color={active ? 'magenta' : 'cyan'}>{c.name}</Text>
              {c.args.length > 0 && (
                <>
                  {' '}
                  <Text dimColor>{argShape(c)}</Text>
                </>
              )}
              {'  '}
              <Text dimColor>— {c.description}</Text>
            </Text>
          );
        })
      )}
      <Text dimColor>↑↓ move · Enter run · Esc close</Text>
    </Box>
  );
}
```

- [ ] **Step 2: Build**

Run: `npm run build`

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/cli/ink/palette/Palette.tsx
git commit -m "feat(ink): Palette (Ctrl-K) overlay with fuzzy search"
```

---

## Task 13: `HintBar.tsx`

**Files:**
- Create: `src/cli/ink/HintBar.tsx`

- [ ] **Step 1: Create `src/cli/ink/HintBar.tsx`**

```typescript
import React from 'react';
import { Box, Text } from 'ink';
import type { View } from './views.js';

const HINTS: Record<View['kind'], string> = {
  home:   'Ctrl-K commands · /join #room · /dm peer · 1-9 jump · ? help',
  dm:     'Tab complete · Ctrl-K commands · /watch peer · /back home · ? help',
  room:   'Tab complete · Ctrl-K commands · /leave · /back home · ? help',
  rooms:  '↑↓ move · Enter open/join · /back home',
  who:    '/back close · ? help',
  help:   '/back close',
};

export function HintBar({ view }: { view: View }): React.ReactElement {
  return (
    <Box paddingX={1}>
      <Text dimColor>{HINTS[view.kind]}</Text>
    </Box>
  );
}
```

- [ ] **Step 2: Build**

Run: `npm run build`

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/cli/ink/HintBar.tsx
git commit -m "feat(ink): context-aware HintBar"
```

---

## Task 14: `HelpPane.tsx`

**Files:**
- Create: `src/cli/ink/panes/HelpPane.tsx`

- [ ] **Step 1: Create `src/cli/ink/panes/HelpPane.tsx`**

```typescript
import React from 'react';
import { Box, Text } from 'ink';
import { CATEGORIES, CATEGORY_LABELS, argShape, commandsByCategory } from '../commands.js';

export function HelpPane(): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text bold color="cyan">help</Text>
      <Text dimColor>{'─'.repeat(50)}</Text>
      {CATEGORIES.map((cat) => (
        <Box key={cat} flexDirection="column" marginTop={1}>
          <Text bold color="magenta">{CATEGORY_LABELS[cat]}</Text>
          {commandsByCategory(cat).map((c) => (
            <Text key={c.name}>
              {'  '}
              <Text color="cyan" bold>{c.name}</Text>
              {c.args.length > 0 && (
                <>
                  {' '}
                  <Text dimColor>{argShape(c)}</Text>
                </>
              )}
              {'  '}
              <Text dimColor>{c.description}</Text>
            </Text>
          ))}
        </Box>
      ))}
      <Box marginTop={1} flexDirection="column">
        <Text bold color="magenta">KEYBOARD</Text>
        <Text>  <Text color="cyan" bold>Ctrl-K</Text>   command palette</Text>
        <Text>  <Text color="cyan" bold>Tab</Text>      complete peer/room in current arg</Text>
        <Text>  <Text color="cyan" bold>↑↓</Text>       navigate autocomplete / palette</Text>
        <Text>  <Text color="cyan" bold>1-9</Text>      jump to sidebar entry (when input empty)</Text>
        <Text>  <Text color="cyan" bold>R</Text>        open /rooms browser (when input empty)</Text>
        <Text>  <Text color="cyan" bold>?</Text>        open this help (when input empty)</Text>
        <Text>  <Text color="cyan" bold>Ctrl-A/E</Text>  cursor start/end of line</Text>
        <Text>  <Text color="cyan" bold>Ctrl-W</Text>    delete previous word</Text>
        <Text>  <Text color="cyan" bold>Ctrl-U</Text>    delete to start of line</Text>
        <Text>  <Text color="cyan" bold>Opt-←/→</Text>   word navigation (Mac)</Text>
        <Text>  <Text color="cyan" bold>Opt-⌫</Text>     delete previous word (Mac)</Text>
        <Text>  <Text color="cyan" bold>Ctrl-C</Text>    quit</Text>
        <Text dimColor>  (Cmd-* combos are intercepted by the terminal and unavailable.)</Text>
      </Box>
    </Box>
  );
}
```

- [ ] **Step 2: Build**

Run: `npm run build`

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/cli/ink/panes/HelpPane.tsx
git commit -m "feat(ink): formatted HelpPane rendering command catalogue"
```

---

## Task 15: Sidebar shape B (joined + discover rooms)

**Files:**
- Modify: `src/cli/ink/panes/Sidebar.tsx`

- [ ] **Step 1: Update `SidebarProps` to accept a discover list**

Change the interface:

```typescript
import type { Room } from '../../../storage/dao.js';

export interface SidebarProps {
  handle: string;
  view: View;
  peers: Agent[];
  memberRooms: Room[];       // was `rooms: ReturnType<typeof dao.myRooms>;`
  discoverRooms: Room[];     // NEW
  dmUnreadByPeer: Map<string, number>;
  roomUnreadByName: Map<string, number>;
}
```

- [ ] **Step 2: Replace the ROOMS block**

Replace the existing ROOMS rendering block with:

```typescript
<Box marginTop={1}>
  <Text bold color="magenta">ROOMS</Text>
</Box>
{memberRooms.length === 0 && discoverRooms.length === 0 ? (
  <Text dimColor>(none — /join #x)</Text>
) : (
  <>
    {memberRooms.map((r) => {
      const active = view.kind === 'room' && view.room === r.name;
      const unread = roomUnreadByName.get(r.name) ?? 0;
      return (
        <Text key={r.name}>
          {active ? <Text color="cyan">▸ </Text> : <Text>  </Text>}
          <Text color={active ? 'cyan' : 'cyan'} bold={active}>{r.name}</Text>
          {unread > 0 && <Text color="yellow"> ({unread})</Text>}
        </Text>
      );
    })}
    {discoverRooms.length > 0 && (
      <Text dimColor>  ── join ──</Text>
    )}
    {discoverRooms.map((r) => (
      <Text key={r.name}>
        {'  '}
        <Text color="gray">＋ </Text>
        <Text dimColor>{r.name}</Text>
      </Text>
    ))}
  </>
)}
```

- [ ] **Step 3: Build**

Run: `npm run build`

Expected: **failure** — App.tsx still passes the old `rooms` prop. That will be fixed in Task 21.

Skip commit until App.tsx wire-up compiles.

- [ ] **Step 4: Note for next task**

The old prop wire-up in App.tsx needs to change from `rooms={rooms}` to `memberRooms={...} discoverRooms={...}`. Done in Task 21.

---

## Task 16: `RoomsBrowserPane.tsx`

**Files:**
- Create: `src/cli/ink/panes/RoomsBrowserPane.tsx`

- [ ] **Step 1: Create `src/cli/ink/panes/RoomsBrowserPane.tsx`**

```typescript
import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { Db } from '../../../storage/db.js';
import type { Room } from '../../../storage/dao.js';
import * as dao from '../../../storage/dao.js';

export interface RoomsBrowserProps {
  db: Db;
  handle: string;
  rooms: Room[];
  onOpen: (room: string) => void;
  onJoin: (room: string) => void;
}

function summariseMembers(db: Db, name: string, max = 3): string {
  const members = dao.roomMembers(db, name);
  const head = members.slice(0, max).join(', ');
  const extra = members.length > max ? ` +${members.length - max}` : '';
  return `${head}${extra}`;
}

export function RoomsBrowserPane({ db, handle, rooms, onOpen, onJoin }: RoomsBrowserProps): React.ReactElement {
  const [selected, setSelected] = useState(0);

  useInput((_raw, key) => {
    if (key.upArrow) return setSelected((i) => Math.max(0, i - 1));
    if (key.downArrow) return setSelected((i) => Math.min(rooms.length - 1, i + 1));
    if (key.return) {
      const r = rooms[selected];
      if (!r) return;
      if (dao.isRoomMember(db, r.name, handle)) onOpen(r.name);
      else onJoin(r.name);
    }
  });

  return (
    <Box flexDirection="column">
      <Text bold color="cyan">Rooms · {rooms.length} active</Text>
      <Text dimColor>{'─'.repeat(50)}</Text>
      {rooms.length === 0 ? (
        <Text dimColor>(no rooms yet — /join #x to create one)</Text>
      ) : (
        rooms.map((r, i) => {
          const active = i === selected;
          const joined = dao.isRoomMember(db, r.name, handle);
          const summary = summariseMembers(db, r.name);
          return (
            <Text key={r.name}>
              {active ? <Text color="cyan">▸</Text> : <Text> </Text>}
              {joined ? <Text color="cyan"> ✓ </Text> : <Text>   </Text>}
              <Text bold={active} color={active ? 'cyan' : joined ? 'cyan' : undefined}>{r.name.padEnd(14)}</Text>
              {'  '}
              <Text dimColor>{r.member_count} members · {summary}</Text>
            </Text>
          );
        })
      )}
      <Box marginTop={1}>
        <Text dimColor>↑↓ move · Enter open/join · /back close</Text>
      </Box>
    </Box>
  );
}
```

- [ ] **Step 2: Build**

Run: `npm run build`

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/cli/ink/panes/RoomsBrowserPane.tsx
git commit -m "feat(ink): RoomsBrowserPane — Enter opens or joins"
```

---

## Task 17: `EmptyState.tsx`

**Files:**
- Create: `src/cli/ink/panes/EmptyState.tsx`

- [ ] **Step 1: Create `src/cli/ink/panes/EmptyState.tsx`**

```typescript
import React from 'react';
import { Box, Text } from 'ink';

export function HomeEmptyState(): React.ReactElement {
  return (
    <Box flexDirection="column" marginTop={2} paddingX={2}>
      <Text>Nothing to show yet.</Text>
      <Text> </Text>
      <Text>  <Text color="cyan" bold>Ctrl-K</Text>       browse commands</Text>
      <Text>  <Text color="cyan" bold>/dm claude1</Text>  start a DM</Text>
      <Text>  <Text color="cyan" bold>/join #x</Text>     join or discover a room</Text>
      <Text>  <Text color="cyan" bold>1-9</Text>          jump to a sidebar entry</Text>
    </Box>
  );
}

export function DmEmptyState({ peer }: { peer: string }): React.ReactElement {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>No messages yet.</Text>
      <Text> </Text>
      <Text>Say hi, or send a tagged message:</Text>
      <Text>  <Text color="cyan" bold>/dispatch {peer} &lt;text&gt;</Text></Text>
    </Box>
  );
}

export function RoomEmptyState({ room }: { room: string }): React.ReactElement {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>No messages in {room} yet.</Text>
      <Text> </Text>
      <Text>  <Text color="cyan" bold>/broadcast {room} &lt;text&gt;</Text>   post to the room</Text>
      <Text>  <Text color="cyan" bold>/leave</Text>                     leave the room</Text>
    </Box>
  );
}
```

- [ ] **Step 2: Build**

Run: `npm run build`

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/cli/ink/panes/EmptyState.tsx
git commit -m "feat(ink): contextual empty-state panels"
```

---

## Task 18: Wire Input + Autocomplete into `App.tsx`

**Files:**
- Modify: `src/cli/ink/App.tsx`
- Modify: `package.json`

Substantial. Break into steps.

- [ ] **Step 1: Remove `ink-text-input`**

In `App.tsx`, delete `import TextInput from 'ink-text-input';`. Remove `ink-text-input` from `package.json` dependencies.

Run: `npm install` to update lockfile.

- [ ] **Step 2: Convert `input` state to `{value, cursor}`**

Replace:

```typescript
const [input, setInput] = useState('');
```

With:

```typescript
const [input, setInput] = useState<{ value: string; cursor: number }>({ value: '', cursor: 0 });
const [completionIndex, setCompletionIndex] = useState(0);
```

- [ ] **Step 3: Build the completion context**

Add these top-of-file imports (`dao` is already namespace-imported — use it):

```typescript
import { getCompletions } from './input/completions.js';
import type { Completion } from './input/completions.js';
```

Just before the `return()`, add:

```typescript
const allRoomsList = useMemo(() => dao.allRooms(db), [db, tick]);
const discoverRooms = useMemo(
  () => allRoomsList.filter((r) => !rooms.some((mr) => mr.name === r.name) && r.member_count > 0),
  [allRoomsList, rooms],
);

const completions: Completion[] = useMemo(() => {
  return getCompletions(input.value, input.cursor, {
    me: handle,
    peers: peers.map((p) => p.handle),
    memberRooms: rooms.map((r) => r.name),
    discoverRooms: discoverRooms.map((r) => r.name),
  });
}, [input.value, input.cursor, peers, rooms, discoverRooms, handle]);
```

- [ ] **Step 4: Wire the `Input` component**

Replace the existing input-bar `<Box>` block with:

```typescript
import { Input } from './input/Input.js';
import { Autocomplete } from './input/Autocomplete.js';

// …inside return():
<Box flexDirection="column">
  {completions.length > 0 && (
    <Autocomplete completions={completions} selectedIndex={completionIndex} />
  )}
  <Box borderStyle="round" borderColor="gray" paddingX={1}>
    <Input
      value={input.value}
      cursor={input.cursor}
      onChange={(value, cursor) => { setInput({ value, cursor }); setCompletionIndex(0); }}
      onSubmit={(v) => { handleSubmit(v); setInput({ value: '', cursor: 0 }); }}
      onTab={() => {
        // Tab-complete: replace current token with the selected completion + trailing space.
        const c = completions[completionIndex];
        if (!c) return;
        const before = input.value.slice(0, input.cursor);
        const after = input.value.slice(input.cursor);
        const tokenStart = Math.max(before.lastIndexOf(' '), before.lastIndexOf('#') - 1) + 1;
        const nextValue = input.value.slice(0, tokenStart) + c.value + ' ' + after;
        const nextCursor = tokenStart + c.value.length + 1;
        setInput({ value: nextValue, cursor: nextCursor });
        setCompletionIndex(0);
      }}
      onEsc={() => {
        if (completions.length > 0) { setInput({ value: '', cursor: 0 }); setCompletionIndex(0); }
      }}
      onUp={() => setCompletionIndex((i) => Math.max(0, i - 1))}
      onDown={() => setCompletionIndex((i) => Math.min(completions.length - 1, i + 1))}
    />
  </Box>
</Box>
```

- [ ] **Step 5: Build + smoke**

Run: `npm run build && node dist/index.js cli --experimental --handle testuser`

Manual test:
- Type `/d` — dropdown shows `/dm`, `/dispatch`.
- Type `/dm ` — dropdown shows peers.
- Type `Ctrl-A` — cursor jumps to start.
- Type `Ctrl-U` — line clears.
- Type `Opt-Backspace` — word deletes.

Expected: all behave as described. If cursor rendering looks off (e.g. block cursor overlaps a char), that's OK for MVP — we can polish later.

- [ ] **Step 6: Commit**

```bash
git add src/cli/ink/App.tsx package.json package-lock.json
git commit -m "feat(ink): wire hand-rolled Input + Autocomplete into App"
```

---

## Task 19: Wire Palette (Ctrl-K)

**Files:**
- Modify: `src/cli/ink/App.tsx`

- [ ] **Step 1: Add palette-open state**

```typescript
const [paletteOpen, setPaletteOpen] = useState(false);
```

- [ ] **Step 2: Bind Ctrl-K to open**

Replace the existing `useInput((_input, key) => { if (key.ctrl && _input === 'c') exit(); });` block with:

```typescript
useInput((raw, key) => {
  if (key.ctrl && raw === 'c') exit();
  if (key.ctrl && raw === 'k' && !paletteOpen) setPaletteOpen(true);
});
```

Note: `useInput` fires globally when no active `Input` claims the key. The child `Input` component's own `useInput` handler DOES receive keys — so the ctrl-k here fires alongside anything the input does with `k`, but `input.value += 'k'` would only happen if the user held Ctrl too, and the input ignores ctrl-modified keys already.

- [ ] **Step 3: Render the palette overlay + gate the input while open**

Immediately below the alert lane render:

```typescript
import { Palette } from './palette/Palette.js';

// …
{paletteOpen && (
  <Palette
    onClose={() => setPaletteOpen(false)}
    onSelect={(cmd) => {
      setPaletteOpen(false);
      if (cmd.args.length === 0) {
        doCommand(cmd.name);
      } else {
        setInput({ value: cmd.name + ' ', cursor: cmd.name.length + 1 });
      }
    }}
  />
)}
```

**Critical**: wrap the `Input` block (from Task 18 Step 4) in `{!paletteOpen && (...)}` so it unmounts while the palette is open. Otherwise Ink dispatches keys to both `useInput` handlers — Enter in the palette would also submit the input. Change:

```typescript
{!paletteOpen && (
  <Box flexDirection="column">
    {completions.length > 0 && (
      <Autocomplete completions={completions} selectedIndex={completionIndex} />
    )}
    <Box borderStyle="round" borderColor="gray" paddingX={1}>
      <Input …/>
    </Box>
  </Box>
)}
```

- [ ] **Step 4: Build + smoke**

Run: `npm run build && node dist/index.js cli --experimental --handle testuser`

Manual test:
- Ctrl-K opens palette.
- Type `jo` — matches `/join`.
- Enter — input contains `/join ` with cursor at end.
- Ctrl-K → `who` → Enter — /who view opens directly (no arg).
- Esc — palette closes.

- [ ] **Step 5: Commit**

```bash
git add src/cli/ink/App.tsx
git commit -m "feat(ink): wire Ctrl-K palette overlay"
```

---

## Task 20: Wire HelpPane (`/help` + `?`) + RoomsBrowser (`/rooms` + `R`)

**Files:**
- Modify: `src/cli/ink/App.tsx`

- [ ] **Step 1: Route `help` and `rooms` views**

In the main-pane render (`view.kind === 'who' ? <WhoPane…> : <MessagesPane…>`), extend the ternary chain:

```typescript
{view.kind === 'who' ? (
  <WhoPane peers={peers} meHandle={handle} />
) : view.kind === 'help' ? (
  <HelpPane />
) : view.kind === 'rooms' ? (
  <RoomsBrowserPane
    db={db}
    handle={handle}
    rooms={allRoomsList.filter((r) => r.member_count > 0)}
    onOpen={(room) => setView({ kind: 'room', room })}
    onJoin={(room) => {
      const result = dao.joinRoom(db, room, handle);
      if (result.was_new_member && result.system_message) {
        for (const member of dao.roomMembers(db, room)) {
          if (member === handle) continue;
          notifyPeer(member, { id: result.system_message.id, to: room, from: dao.SYSTEM_HANDLE, ts: result.system_message.sent_at });
        }
      }
      setView({ kind: 'room', room });
      setTick((t) => t + 1);
    }}
  />
) : (
  <MessagesPane view={view} messages={messages} meHandle={handle} />
)}
```

Imports:

```typescript
import { HelpPane } from './panes/HelpPane.js';
import { RoomsBrowserPane } from './panes/RoomsBrowserPane.js';
```

- [ ] **Step 2: Route `/help` and `/rooms` commands**

Update the command switch in `doCommand`:

```typescript
case 'help':
  setView({ kind: 'help' });
  return;
case 'rooms':
  setView({ kind: 'rooms' });
  return;
```

Remove the old `/help` status-line dump (previously `setStatus('/dm /join #x ...')`).

- [ ] **Step 3: Bind `?` and `R` hotkeys (input empty only)**

Extend the global `useInput`:

```typescript
useInput((raw, key) => {
  if (key.ctrl && raw === 'c') exit();
  if (key.ctrl && raw === 'k' && !paletteOpen) return setPaletteOpen(true);

  // Empty-input hotkeys
  if (input.value.length > 0 || paletteOpen) return;
  if (raw === '?') return setView({ kind: 'help' });
  if (raw === 'R' || raw === 'r') return setView({ kind: 'rooms' });
});
```

- [ ] **Step 4: Build + smoke**

Run: `npm run build && node dist/index.js cli --experimental --handle testuser`

Manual test:
- `/help` → HelpPane renders (categorised).
- `?` (empty input) → HelpPane renders.
- `/rooms` → RoomsBrowserPane renders.
- `R` (empty input) → RoomsBrowserPane renders.
- In browser, `↑/↓` moves selection, Enter on unjoined joins + opens.

- [ ] **Step 5: Commit**

```bash
git add src/cli/ink/App.tsx
git commit -m "feat(ink): /help pane + /rooms browser + ? / R hotkeys"
```

---

## Task 21: Wire Sidebar shape B

**Files:**
- Modify: `src/cli/ink/App.tsx`

- [ ] **Step 1: Update Sidebar wire-up**

Replace `<Sidebar … rooms={rooms} … />` with:

```typescript
<Sidebar
  handle={handle}
  view={view}
  peers={peers}
  memberRooms={rooms}
  discoverRooms={discoverRooms}
  dmUnreadByPeer={dmUnreadByPeer}
  roomUnreadByName={roomUnreadByName}
/>
```

- [ ] **Step 2: Build + smoke**

Run: `npm run build && node dist/index.js cli --experimental --handle testuser`

Manual test:
- With one joined room (`#leagues`) and one unjoined (`#planning` created by another handle), sidebar shows both, styled per spec.
- If no joined rooms, only the divider + discover list shows.
- If no rooms at all, the `(none — /join #x)` fallback shows.

- [ ] **Step 3: Commit**

```bash
git add src/cli/ink/App.tsx src/cli/ink/panes/Sidebar.tsx
git commit -m "feat(ink): sidebar shape B — joined + discover rooms"
```

---

## Task 22: Wire HintBar + EmptyState

**Files:**
- Modify: `src/cli/ink/App.tsx`
- Modify: `src/cli/ink/panes/MessagesPane.tsx`

- [ ] **Step 1: Render `HintBar` above the input**

Import:

```typescript
import { HintBar } from './HintBar.js';
```

Insert immediately before the input `<Box flexDirection="column">`:

```typescript
<HintBar view={view} />
```

- [ ] **Step 2: Route empty states inside MessagesPane**

Modify `MessagesPane.tsx`:

```typescript
import { HomeEmptyState, DmEmptyState, RoomEmptyState } from './EmptyState.js';

// Inside the function, replace the `(no messages)` fallback:
{messages.length === 0 ? (
  view.kind === 'home' ? <HomeEmptyState /> :
  view.kind === 'dm' ? <DmEmptyState peer={view.peer} /> :
  view.kind === 'room' ? <RoomEmptyState room={view.room} /> :
  null
) : (
  messages.map(/* existing */)
)}
```

- [ ] **Step 3: Build + smoke**

Run: `npm run build && node dist/index.js cli --experimental --handle testuser`

Manual test:
- home view shows HomeEmptyState + hint bar with home hints.
- `/dm claude1` (assuming registered peer) → DM view with DmEmptyState + DM hint bar.
- `/join #new` → RoomEmptyState + room hint bar.
- `/who` → hint bar shows `/back close · ? help`.

- [ ] **Step 4: Commit**

```bash
git add src/cli/ink/App.tsx src/cli/ink/panes/MessagesPane.tsx
git commit -m "feat(ink): HintBar + empty-state panels per view"
```

---

## Task 23: Number-key jumps (1-9)

**Files:**
- Modify: `src/cli/ink/App.tsx`

- [ ] **Step 1: Extend the global `useInput`**

```typescript
useInput((raw, key) => {
  if (key.ctrl && raw === 'c') exit();
  if (key.ctrl && raw === 'k' && !paletteOpen) return setPaletteOpen(true);

  if (input.value.length > 0 || paletteOpen) return;

  if (raw === '?') return setView({ kind: 'help' });
  if (raw === 'R' || raw === 'r') return setView({ kind: 'rooms' });

  if (/^[1-9]$/.test(raw)) {
    const n = parseInt(raw, 10) - 1;
    // Order: peers first, then joined rooms, then discover rooms (skip divider).
    const targets: Array<{ kind: 'dm'; peer: string } | { kind: 'room'; room: string; join?: boolean }> = [
      ...peers.map((p) => ({ kind: 'dm' as const, peer: p.handle })),
      ...rooms.map((r) => ({ kind: 'room' as const, room: r.name })),
      ...discoverRooms.map((r) => ({ kind: 'room' as const, room: r.name, join: true })),
    ];
    const t = targets[n];
    if (!t) return;
    if (t.kind === 'dm') {
      setView({ kind: 'dm', peer: t.peer });
    } else if (t.join) {
      const result = dao.joinRoom(db, t.room, handle);
      if (result.was_new_member && result.system_message) {
        for (const member of dao.roomMembers(db, t.room)) {
          if (member === handle) continue;
          notifyPeer(member, { id: result.system_message.id, to: t.room, from: dao.SYSTEM_HANDLE, ts: result.system_message.sent_at });
        }
      }
      setView({ kind: 'room', room: t.room });
      setTick((tk) => tk + 1);
    } else {
      setView({ kind: 'room', room: t.room });
    }
  }
});
```

- [ ] **Step 2: Build + smoke**

Run: `npm run build && node dist/index.js cli --experimental --handle testuser`

Manual test:
- With one peer + one joined room + one discover room visible: pressing `1` opens DM, `2` opens joined room, `3` joins + opens the discover room.
- Typing "1" as the first char of a message: is swallowed by the jump. Verify by pressing `/dm claude1<Enter>` then trying to type "1 sec" as a message — should NOT get swallowed once inside the DM view because pressing `/` first put a char in the buffer. Actually per rule: input-empty gating, so "1" gets swallowed. Confirm and note as spec §5's known limitation.

- [ ] **Step 3: Commit**

```bash
git add src/cli/ink/App.tsx
git commit -m "feat(ink): number-key sidebar jumps (1-9 when input empty)"
```

---

## Task 24: Version bump + integration smoke

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Bump version**

Edit `package.json`:

```json
"version": "0.3.0",
```

(Per memory: any behavior-changing PR against edgecase123/chat-mcp bumps the version.)

- [ ] **Step 2: Full run-through of spec verification list**

Per spec §Testing:

1. **Autocomplete** — with two peers online (start two shims: `chat-mcp --handle claude1 &`, `chat-mcp --handle claude2 &`), then `chat-mcp cli --experimental --handle me`:
   - `/d<Tab>` → menu of `/dm`, `/dispatch`.
   - `/dm cla<Tab>` → completes to `/dm claude1 `.
2. **Palette** — Ctrl-K → type `join` → Enter → input has `/join `.
3. **Rooms sidebar** — join `#leagues` from `me`, then from another shim have `claude1` join `#planning`. Reload the Ink UI — sidebar shows `#leagues` cyan + `＋ #planning` dim.
4. **/rooms browser** — `R` (empty input) opens the pane. `↑↓` moves. Enter on `#planning` (not joined) joins + opens.
5. **Hint bar** — walk through home / dm / room / /who / /rooms / /help — hint text changes per view.
6. **Empty states** — /dm to a fresh peer shows DmEmptyState; new room shows RoomEmptyState.
7. **Input editing** — type `hello world foo bar`; Opt-Backspace deletes `bar`; Ctrl-U clears; Opt-Left/Right steps; Ctrl-A/E jumps.

Any failure → open a task in the plan to fix, do not mark complete.

- [ ] **Step 3: Run the existing smoke script (does not cover Ink)**

Run: `npm run smoke`

Expected: all criteria pass (this exercises non-Ink CLI + MCP shim; regressions here indicate an accidental change to shared modules).

- [ ] **Step 4: Update `README.md` if it references the old input**

Run: `grep -n 'ink-text-input\|TextInput' README.md DESIGN.md 2>/dev/null || echo 'no refs'`

If references exist, replace with a brief note that the Ink CLI uses a hand-rolled input. If not, skip.

- [ ] **Step 5: Commit + push**

```bash
git add package.json README.md DESIGN.md 2>/dev/null
git status
git commit -m "chore(ink): v0.3.0 — ship UI tweaks (spec 2026-07-26)"
```

Open a PR against `main` referencing the design spec + plan.

---

## Verification checklist (end-to-end)

- [ ] `npm test` — all unit tests pass (commands, fuzzy, completions).
- [ ] `npm run build` — no TypeScript errors.
- [ ] `npm run smoke` — MCP shim + non-Ink CLI still green.
- [ ] Manual Ink smoke — spec verification list #1-#7 (Task 24 Step 2).
- [ ] `ink-text-input` no longer in `package.json` `dependencies`.
- [ ] No file in `src/cli/ink/` exceeds ~250 lines.
- [ ] `App.tsx` is the composition root only — no inline component definitions beyond it.
