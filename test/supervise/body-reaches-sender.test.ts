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
  [
    'src/cli/ink/App.tsx :: notifyPeer(member, { id: 0, to: member, from: dao.SYSTEM_HANDLE, ts: Date.now() });',
    'presence ping, id 0, there is no message',
  ],
  [
    'src/cli/ink/App.tsx :: notifyPeer(target, { id: 0, to: target, from: dao.SYSTEM_HANDLE, ts: Date.now() });',
    'presence ping, id 0, there is no message',
  ],
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

/**
 * A STABLE identity for a call site: the file plus the call itself.
 *
 * 🛑 THESE WERE LINE NUMBERS AND IT BROKE TWICE IN ONE HOUR. Adding the
 * approvals handler shifted `server.ts:296` to `299`; adding the approvals
 * poll shifted it again. Each time the failure reads as a NEW violation, and
 * the fix is to edit a number — which trains the next person to edit the
 * number rather than look at the call.
 *
 * ⚠️ The key changes if the call's own text changes, and that is deliberate:
 * an exception is a claim about one specific call, so editing the call should
 * invalidate the claim.
 */
function siteKey(rel: string, call: string): string {
  // ⚠️ COMMENTS ARE STRIPPED FIRST. Without this the key tracked PROSE: adding
  // an explanatory comment inside the call changed its identity and the
  // exemption read as a new violation. An exception is a claim about the
  // CODE, so editing a comment must not invalidate it.
  const code = call
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return `${rel} :: ${code}`;
}

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

      dropped.push(siteKey(rel, m[0]));
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
/**
 * 🛑 KEYED ON THE CALL ITSELF, NOT ON A LINE NUMBER.
 *
 * These were line numbers and it broke TWICE IN ONE HOUR: adding the
 * approvals handler shifted `server.ts:296` to `299`, and adding the
 * approvals poll shifted it again. Each time the failure reads as a NEW
 * violation, and the fix is to edit a number — which trains the next person
 * to edit the number rather than look at the call.
 *
 * ⚠️ THE TRADE: two byte-identical calls in one file collapse to one key, so
 * an exemption would cover both. That is a smaller hazard than a list that
 * goes stale on every unrelated insertion.
 */
const KIND_EXEMPT = new Map<string, string>([
  [
    'src/cli/ink/App.tsx :: notifyPeer(member, { id: 0, to: member, from: dao.SYSTEM_HANDLE, ts: Date.now() });',
    'presence ping, id 0, there is no message',
  ],
  [
    'src/cli/ink/App.tsx :: notifyPeer(target, { id: 0, to: target, from: dao.SYSTEM_HANDLE, ts: Date.now() });',
    'presence ping, id 0, there is no message',
  ],
  [
    'src/cli/ink/App.tsx :: notifyPeer(member, { id: result.system_message.id, to: roomArg, from: dao.SYSTEM_HANDLE, ts: result.system_message.sent_at, body: result.system_message.body, });',
    'room-join system notice, no caller kind',
  ],
  [
    'src/cli/ink/App.tsx :: notifyPeer(member, { id: result.system_message.id, to: name, from: dao.SYSTEM_HANDLE, ts: result.system_message.sent_at, body: result.system_message.body, });',
    'room-join system notice, no caller kind',
  ],
  [
    'src/cli/ink/App.tsx :: notifyPeer(member, { id: joinRes.system_message.id, to: roomArg, from: dao.SYSTEM_HANDLE, ts: joinRes.system_message.sent_at, body: joinRes.system_message.body });',
    'room-join system notice, no caller kind',
  ],
  [
    'src/cli/ink/App.tsx :: notifyPeer(member, { id: r.system_message.id, to: roomArg, from: dao.SYSTEM_HANDLE, ts: r.system_message.sent_at, body: r.system_message.body });',
    'room-join system notice, no caller kind',
  ],
  [
    'src/cli/ink/App.tsx :: notifyPeer(member, { id: result.system_message.id, to: t.room, from: dao.SYSTEM_HANDLE, ts: result.system_message.sent_at, body: result.system_message.body });',
    'room-join system notice, no caller kind',
  ],
  [
    'src/cli/ink/App.tsx :: notifyPeer(member, { id: result.system_message.id, to: room, from: dao.SYSTEM_HANDLE, ts: result.system_message.sent_at, body: result.system_message.body });',
    'room-join system notice, no caller kind',
  ],
  [
    'src/cli/web/server.ts :: notifyPeer(member, { id: result.system_message.id, to: body.room, from: dao.SYSTEM_HANDLE, ts: result.system_message.sent_at, body: result.system_message.body });',
    'room-join system notice, no caller kind',
  ],
  [
    'src/cli/web/server.ts :: notifyPeer(request.supervisorHandle, { id, to: request.supervisorHandle, from: ctx.handle, ts: Date.now(), body: `approval ${id} ${decision}: ${request.requested ?? \'(unnamed)\'}`, approval: { approvalId: id, decision, requested: request.requested ?? \'\', sessionId: request.sessionId, }, });',
    'approval answer; no caller kind exists, the body and the typed field carry it',
  ],
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

      const site = siteKey(rel, m[0]);

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
