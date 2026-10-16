import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 🛑 THIS TEST IS SCOPED TO THE SURFACE, NOT TO A FIX, AND THAT IS THE POINT.
 *
 * Its first version listed the three files the fix had touched. claude1
 * reviewing PR 34: *"its `PATHS` lists the THREE FILES THE FIX TOUCHED.
 * Scoped to the fix, not the surface, so it can only confirm what you already
 * changed."* **24 of 28 `notifyPeer` calls were dropping the body and the test
 * could not see any of them**, including an `App.tsx` all-hands that sent
 * `kind: 'alert'` with the body one line above.
 *
 * So it now walks every source file. A call that cannot pass a body must be
 * named in ALLOWED below with a reason, which makes each omission a decision
 * rather than an oversight.
 */

/**
 * Calls with genuinely no message text in scope.
 *
 * ⚠️ Each line is a claim about what is reachable at that call site. If one
 * gains a body, delete its entry rather than widening this list.
 */
const ALLOWED = new Map<string, string>([
  // Room-boot fan-outs hold only the system message's id and timestamp — the
  // text itself is never loaded into scope at the call site.
  ['src/cli/index.ts:306', 'boot fan-out: only sysId and now are in scope'],
  ['src/oneshot/boot.ts:42', 'boot fan-out: only sysId and now are in scope'],
  ['src/shim/tools/room_boot.ts:48', 'boot fan-out: only sysId and now are in scope'],
  // `id: 0` is the "no specific message" marker: a presence ping with no text
  // to carry at all.
  ['src/cli/ink/App.tsx:343', 'presence ping, id 0, there is no message'],
  ['src/cli/ink/App.tsx:357', 'presence ping, id 0, there is no message'],
]);

function sources(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);

    if (statSync(full).isDirectory()) sources(full, acc);
    else if (/\.tsx?$/.test(entry)) acc.push(full);
  }

  return acc;
}

const ROOT = new URL('../../', import.meta.url).pathname;

function dropSites(): string[] {
  const dropped: string[] = [];

  for (const file of sources(join(ROOT, 'src'))) {
    const rel = file.slice(ROOT.length);

    // bus.ts defines the envelope; socket.ts only mentions notifyPeer in prose.
    if (rel.endsWith('notify/bus.ts') || rel.endsWith('supervise/socket.ts')) continue;

    const source = readFileSync(file, 'utf8');

    for (const m of source.matchAll(/notifyPeer\((?:[^()]|\([^()]*\))*?\);/gs)) {
      if (/\bbody\b/.test(m[0])) continue;

      const line = source.slice(0, m.index).split('\n').length;
      dropped.push(`${rel}:${line}`);
    }
  }

  return dropped;
}

test('every notifyPeer call either carries the body or is a named exception', () => {
  const unexplained = dropSites().filter((site) => !ALLOWED.has(site));

  assert.deepEqual(
    unexplained,
    [],
    `these wakes drop the message body with no justification:\n  ${unexplained.join('\n  ')}\n`
      + 'A woken agent then pays a tool round-trip calling inbox before it can act.',
  );
});

test('the exception list has no stale entries', () => {
  // An ALLOWED entry for a call that now passes a body is a lie that makes the
  // list look considered when it is not.
  const dropping = new Set(dropSites());
  const stale = [...ALLOWED.keys()].filter((site) => !dropping.has(site));

  assert.deepEqual(stale, [], `these exceptions are no longer needed: ${stale.join(', ')}`);
});

test('the scan actually finds calls — a zero-hit scan would pass vacuously', () => {
  // The first version of this test could not see 24 real droppers. A scan that
  // silently matches nothing is the same failure with a different cause.
  const total = dropSites().length + ALLOWED.size;

  assert.ok(total >= 5, `expected to find notifyPeer calls, found ${total}`);
});

test('the two shim chat sends also carry the kind, so an alert is not flattened', () => {
  for (const rel of ['src/shim/tools/send.ts', 'src/shim/tools/room_send.ts']) {
    const source = readFileSync(join(ROOT, rel), 'utf8');
    const calls = [...source.matchAll(/notifyPeer\((?:[^()]|\([^()]*\))*?\);/gs)].map((m) => m[0]);

    assert.ok(calls.length > 0, `${rel} no longer calls notifyPeer`);
    for (const call of calls) {
      assert.match(call, /\bkind\b/, `${rel} drops kind: ${call.replace(/\s+/g, ' ')}`);
    }
  }
});
