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
  // 🛑 THREE BOOT ENTRIES WERE REMOVED FROM HERE, AND THEY WERE FALSE.
  // They claimed "only sysId and now are in scope". claude1 reviewing PR 34
  // found `const body` nine to twelve lines above each call —
  // cli/index.ts:294, oneshot/boot.ts:33, room_boot.ts:39. The justification
  // was written from a three-line window and generalised. All three now pass a
  // body.
  //
  // ⚠️ An entry here is a CLAIM about what is reachable. Verify by reading the
  // enclosing function, not the lines next to the call.
  //
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
      // 🛑 A PROPERTY, not a token. `/\bbody\b/` matched `to: body.room` in
      // web/server.ts, so a room-join wake carrying no message read as
      // compliant. claude1 found the exception list was false; tightening this
      // found a false PASS as well.
      if (/(?:^|[{,\s])body\s*[,:}]/.test(m[0])) continue;

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

test('the scan sees EVERY notifyPeer call — a regex blind spot would hide droppers', () => {
  // 🛑 This replaces an `assert.ok(total >= 5)` that tracked nothing real and
  // broke the moment the number of droppers fell. Both claude1 and I named the
  // same weakness: the structured regex handles one level of nesting, so a
  // call wrapping a deeper expression would be invisible — and invisible
  // droppers are exactly what this file exists to stop.
  //
  // So count occurrences the dumb way and the structured way, and require
  // agreement. A blind spot makes them diverge.
  let occurrences = 0;
  let matched = 0;

  for (const file of sources(join(ROOT, 'src'))) {
    const rel = file.slice(ROOT.length);

    if (rel.endsWith('notify/bus.ts') || rel.endsWith('supervise/socket.ts')) continue;

    const source = readFileSync(file, 'utf8');
    occurrences += [...source.matchAll(/notifyPeer\(/g)].length;
    matched += [...source.matchAll(/notifyPeer\((?:[^()]|\([^()]*\))*?\);/gs)].length;
  }

  assert.ok(occurrences > 20, `expected to find the call sites, found ${occurrences}`);
  assert.equal(
    matched,
    occurrences,
    `the structured regex matched ${matched} of ${occurrences} calls — `
      + 'the unmatched ones are invisible to every other test in this file',
  );
});

/**
 * Calls that carry a body but legitimately no `kind`.
 *
 * ⚠️ `body` does NOT imply `kind`. Fifteen calls pass a body with no kind and
 * are correct: room joins and boots are system notices with no caller-chosen
 * kind, and the CLI's own `send` accepts no kind parameter at all.
 *
 * So the guard is defined by the SURFACE — every file where a `kind` is handed
 * to `insertMessage` must forward it — rather than by the files a fix touched,
 * which is what claude1 rejected in the previous version of this test.
 */
const KIND_EXEMPT = new Map<string, string>([
  // ⚠️ THESE KEYS ARE LINE NUMBERS, so ANY insertion above a call site
  // invalidates its entry and the failure reads as a new violation. Adding the
  // approvals handler moved 296 to 299. Worth keying on something stabler, but
  // that is a change to the guard and not to this list.
  ['src/cli/web/server.ts:299', 'room-join system notice; the kind nearby belongs to the DM handler above'],
  // An approval decision is not a chat `kind` — there is no chat/dispatch/alert
  // to forward. The body carries the decision instead.
  ['src/cli/web/server.ts:366', 'approval answer; no caller kind exists'],
  ['src/cli/ink/App.tsx:376', 'room-join system notice, no caller kind'],
  ['src/cli/ink/App.tsx:415', 'room-join system notice, no caller kind'],
  ['src/cli/ink/App.tsx:563', 'room-join system notice, no caller kind'],
  ['src/cli/ink/App.tsx:602', 'room-join system notice, no caller kind'],
  ['src/cli/ink/App.tsx:729', 'room-join system notice, no caller kind'],
  ['src/cli/ink/App.tsx:874', 'room-join system notice, no caller kind'],
  ['src/cli/ink/App.tsx:343', 'presence ping, id 0'],
  ['src/cli/ink/App.tsx:357', 'presence ping, id 0'],
]);

test('every file that hands a kind to insertMessage forwards it on the wake', () => {
  const unexplained: string[] = [];

  for (const file of sources(join(ROOT, 'src'))) {
    const rel = file.slice(ROOT.length);

    if (rel.endsWith('notify/bus.ts') || rel.endsWith('supervise/socket.ts')) continue;

    const source = readFileSync(file, 'utf8');
    const handsAKind = [...source.matchAll(/insertMessage\([^;]*?\)/gs)].some((m) =>
      /(?:^|[{,\s])kind\s*[,:}]/.test(m[0]),
    );

    if (!handsAKind) continue;

    for (const m of source.matchAll(/notifyPeer\((?:[^()]|\([^()]*\))*?\);/gs)) {
      if (/(?:^|[{,\s])kind\s*[,:}]/.test(m[0])) continue;

      const site = `${rel}:${source.slice(0, m.index).split('\n').length}`;

      if (!KIND_EXEMPT.has(site)) unexplained.push(site);
    }
  }

  assert.deepEqual(
    unexplained,
    [],
    `these wakes drop the kind with no justification:\n  ${unexplained.join('\n  ')}\n`
      + 'An alert then arrives as ordinary chat.',
  );
});
