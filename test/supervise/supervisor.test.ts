import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), 'chat-mcp-sup-'));

const { startSupervisor, formatPrompt } = await import('../../src/supervise/index.js');
const { claudeArgs, routeClaudeEvent } = await import('../../src/supervise/drivers/claude.js');
const { createLineParser } = await import('../../src/supervise/child.js');
const { deliverToSupervisor } = await import('../../src/supervise/socket.js');
import type { AgentChild, SpawnOptions } from '../../src/supervise/child.js';
import type { RateLimitSnapshot } from '../../src/supervise/rate-limit.js';
const { parseClaudeRateLimit: parseRateLimitEvent } = await import('../../src/supervise/drivers/claude-events.js');
import { supervisorOptions } from '../support/supervisor-options.js';

/**
 * 🛑 DIRECTORIES ARE DECLARED, NOT INFERRED. The chat spawns the agent now,
 * so there is no launch terminal to take a working directory from — and
 * `dirsFor` throws rather than guessing. lee, 2026-10-31: *"with the new
 * harness, we'll have to spawn from the chat itself"*.
 */
const SUPERVISOR_TEST_DIRS = [process.cwd()];

/** A fake child. No process, no model, no money. */
function fakeChild(): {
  child: AgentChild;
  sent: string[];
  finishTurn: () => void;
  emitEvent: (e: Record<string, unknown>) => void;
} {
  const sent: string[] = [];
  let endTurn: (() => void) | undefined;
  let usage: ((s: RateLimitSnapshot) => void) | undefined;

  return {
    sent,
    finishTurn: () => endTurn?.(),
    // A fake driver parses the Claude shape exactly as the real one does, so
    // the test fixture stays the payload a live run actually emitted.
    emitEvent: (e: Record<string, unknown>) => {
      const snap = parseRateLimitEvent(e);

      if (snap) usage?.(snap);
      if (e.type === 'result') endTurn?.();
    },
    child: {
      reportsUsage: true,
      reportsContext: true,
      send: (t) => sent.push(t),
      onTurnEnd: (cb) => {
        endTurn = cb;
      },
      onContext: () => undefined,
      onUsage: (cb) => {
        usage = cb;
      },
      // 🛑 ADDED WHEN THE SEAM GREW. These fakes were silently incomplete —
      // the supervisor called `child.onSession` and every test threw. A fake
      // that does not implement the whole interface tests a child that
      // cannot exist.
      onDenial: () => undefined,
      onSession: () => undefined,
      onEvent: () => undefined,
      onExit: () => undefined,
      kill: () => undefined,
    },
  };
}

const start = (handle: string, f: ReturnType<typeof fakeChild>) =>
  startSupervisor(supervisorOptions({ extraDirs: SUPERVISOR_TEST_DIRS,
    handle,
    spawnChild: (_o: SpawnOptions) => f.child,
    log: () => undefined,
  }));

const env = (id: number, body?: string, to = 'sup') => ({ id, to, from: 'claude1', ts: 1, body });

test('argv carries plan mode, denied prompts, AND --verbose', () => {
  const a = claudeArgs();

  assert.deepEqual(a.slice(0, 5), ['-p', '--verbose', '--output-format', 'stream-json', '--input-format']);
  // 🛑 Without --verbose the process exits 1, and no --help text says so.
  assert.ok(a.includes('--verbose'));
  assert.deepEqual(a.slice(a.indexOf('--permission-mode'), a.indexOf('--permission-mode') + 2), ['--permission-mode', 'plan']);
  assert.deepEqual(a.slice(a.indexOf('--permission-prompts'), a.indexOf('--permission-prompts') + 2), ['--permission-prompts', 'none']);
  assert.ok(!a.includes('--dangerously-skip-permissions'));
  assert.ok(!a.includes('bypassPermissions'));
});

test('a delivered message is written to the child as one prompt', async () => {
  const f = fakeChild();
  const s = await start('sup', f);

  try {
    const ack = await deliverToSupervisor('sup', env(1, 'hello there'));

    assert.deepEqual(ack, { ok: true, queued: 'sent' });
    assert.equal(f.sent.length, 1);
    assert.match(f.sent[0]!, /claude1/);
    assert.match(f.sent[0]!, /hello there/);
  } finally {
    await s.stop();
  }
});

test('a message arriving MID-TURN is queued and the ack says so', async () => {
  const f = fakeChild();
  const s = await start('midturn', f);

  try {
    assert.equal((await deliverToSupervisor('midturn', env(1, 'one')))?.queued, 'sent');
    assert.equal((await deliverToSupervisor('midturn', env(2, 'two')))?.queued, 'queued');

    // The measured bug: two writes at once produce ONE turn.
    assert.equal(f.sent.length, 1);
    assert.equal(s.queueDepth, 1);

    f.finishTurn();

    assert.equal(f.sent.length, 2);
    assert.equal(s.queueDepth, 0);
  } finally {
    await s.stop();
  }
});

test('the same message delivered twice is reported as a duplicate, not re-sent', async () => {
  const f = fakeChild();
  const s = await start('dup', f);

  try {
    await deliverToSupervisor('dup', env(5, 'once'));
    f.finishTurn();

    assert.equal((await deliverToSupervisor('dup', env(5, 'once')))?.queued, 'duplicate');
    assert.equal(f.sent.length, 1);
  } finally {
    await s.stop();
  }
});

test('a payload-less wake tells the agent to read its inbox rather than inventing a body', () => {
  const prompt = formatPrompt({ id: 3, to: 'claude2', from: 'claude1', ts: 1 });

  assert.match(prompt, /read your inbox/);
  assert.match(prompt, /no body/);
});

test('a room message names the room', () => {
  assert.match(formatPrompt({ id: 1, to: '#gate', from: 'claude1', ts: 1, body: 'x' }), /in #gate/);
});

test('the line parser holds back a partial line and never emits half an event', () => {
  const seen: Record<string, unknown>[] = [];
  const feed = createLineParser((e) => seen.push(e));

  feed('{"type":"sys');
  assert.equal(seen.length, 0, 'a partial line must not be emitted');

  feed('tem"}\n{"type":"result"}\n');
  assert.deepEqual(seen.map((s) => s.type), ['system', 'result']);
});

test('a non-JSON line on stdout is dropped, not fatal', () => {
  const seen: Record<string, unknown>[] = [];
  const feed = createLineParser((e) => seen.push(e));

  feed('not json at all\n{"type":"result"}\n');

  assert.deepEqual(seen.map((s) => s.type), ['result']);
});

test('an ALERT escalates in the prompt text, not in a field the agent may not read', () => {
  const p = formatPrompt({ id: 1, to: 'claude2', from: 'claude1', ts: 1, body: 'prod is down', kind: 'alert' });

  assert.match(p, /🚨 ALERT — BLOCKING/);
  assert.match(p, /handle it before anything queued behind it/);
  assert.match(p, /prod is down/);
});

test('a DISPATCH is marked as a hand-off, distinctly from an alert', () => {
  const p = formatPrompt({ id: 1, to: 'claude2', from: 'claude1', ts: 1, body: 'take bug 7', kind: 'dispatch' });

  assert.match(p, /📋 DISPATCH/);
  assert.ok(!/ALERT/.test(p), 'a dispatch must not read as an alert');
});

test('a plain chat gets NO banner', () => {
  const p = formatPrompt({ id: 1, to: 'claude2', from: 'claude1', ts: 1, body: 'hi', kind: 'chat' });

  assert.ok(!/ALERT/.test(p));
  assert.ok(!/DISPATCH/.test(p));
});

test('a missing kind is treated as chat, not as an alert', () => {
  // Fail quiet, not loud: an absent field must not manufacture urgency.
  const p = formatPrompt({ id: 1, to: 'claude2', from: 'claude1', ts: 1, body: 'hi' });

  assert.ok(!/ALERT/.test(p));
});

test('an alert with NO body still escalates AND still says to read the inbox', () => {
  // The fallback file path carries no body. An alert must not lose its
  // urgency just because it arrived that way.
  const p = formatPrompt({ id: 9, to: '#gate', from: 'claude1', ts: 1, kind: 'alert' });

  assert.match(p, /🚨 ALERT — BLOCKING/);
  assert.match(p, /read your inbox/);
  assert.match(p, /in #gate/);
});

/** The live payload, at a chosen utilization. */
const rl = (five: number, status = 'allowed') => ({
  type: 'rate_limit_event',
  rate_limit_info: {
    status,
    overageStatus: 'rejected',
    unifiedWindows: { five_hour: { utilization: five, resetsAt: 1 }, seven_day: { utilization: 0.1, resetsAt: 2 } },
  },
});

test('the gate is WIRED, not just built: a full window HOLDS the message', async () => {
  // 🛑 This test exists because RateLimitGate was dead code — 11 tests proving
  // it worked and no caller. Same failure lee caught earlier in this session
  // with the socket body, repeated hours later.
  const f = fakeChild();
  const s = await startSupervisor(supervisorOptions({ extraDirs: SUPERVISOR_TEST_DIRS,
    handle: 'gated',
    spawnChild: () => f.child,
    log: () => undefined,
    utilizationCeiling: 0.9,
  }));

  try {
    await deliverToSupervisor('gated', env(1, 'first'));
    f.finishTurn();
    assert.equal(f.sent.length, 1);

    // The CLI reports the window is full.
    f.emitEvent(rl(0.95));

    const ack = await deliverToSupervisor('gated', env(2, 'second'));

    assert.equal(ack?.queued, 'held', 'a full window must HOLD, not dispatch');
    assert.match(ack?.error ?? '', /five_hour window at 95%/);
    assert.match(ack?.error ?? '', /overage is REJECTED/);
    assert.equal(f.sent.length, 1, 'nothing may be written while held');
    assert.equal(s.heldDepth, 1);
  } finally {
    await s.stop();
  }
});

test('a held message is RELEASED when the window reports room, never dropped', async () => {
  const f = fakeChild();
  const s = await startSupervisor(supervisorOptions({ extraDirs: SUPERVISOR_TEST_DIRS,
    handle: 'release',
    spawnChild: () => f.child,
    log: () => undefined,
    utilizationCeiling: 0.9,
  }));

  try {
    f.emitEvent(rl(0.95));
    await deliverToSupervisor('release', env(1, 'withheld'));
    assert.equal(s.heldDepth, 1);
    assert.equal(f.sent.length, 0);

    // Refusing to spend a turn must not LOSE the message.
    f.emitEvent(rl(0.10));

    assert.equal(s.heldDepth, 0, 'the held message was dropped rather than released');
    assert.equal(f.sent.length, 1);
    assert.match(f.sent[0]!, /withheld/);
  } finally {
    await s.stop();
  }
});

test('a non-allowed status holds even at zero utilization', async () => {
  const f = fakeChild();
  const s = await startSupervisor(supervisorOptions({ extraDirs: SUPERVISOR_TEST_DIRS, handle: 'blocked', spawnChild: () => f.child, log: () => undefined }));

  try {
    f.emitEvent(rl(0.01, 'blocked'));

    assert.equal((await deliverToSupervisor('blocked', env(1, 'x')))?.queued, 'held');
  } finally {
    await s.stop();
  }
});

test('rateLimits() reports utilization and never a dollar figure', async () => {
  const f = fakeChild();
  const s = await startSupervisor(supervisorOptions({ extraDirs: SUPERVISOR_TEST_DIRS, handle: 'report', spawnChild: () => f.child, log: () => undefined }));

  try {
    assert.match(s.rateLimits(), /not yet observed/);

    f.emitEvent(rl(0.52));

    assert.match(s.rateLimits(), /five_hour 52%/);
    assert.ok(!s.rateLimits().includes('$'));
  } finally {
    await s.stop();
  }
});

test('the CLAUDE mapping itself: only `result` ends a turn, and usage is routed', () => {
  // 🛑 This exists because a control that DELETED the mapping from spawnClaude
  // broke nothing — every other supervisor test drives a fake child that
  // signals turn-end directly, so the fake bypassed the only Claude-specific
  // logic in the system.
  let ends = 0;
  const seen: number[] = [];
  const on = {
    turnEnd: () => {
      ends++;
    },
    usage: (s: RateLimitSnapshot) => seen.push(s.windows.five_hour!.utilization),
  };

  for (const type of ['system', 'assistant', 'user', 'tool_use', 'stream_event']) {
    routeClaudeEvent({ type }, on);
  }

  assert.equal(ends, 0, 'assistant text must NOT end a turn — that is what merges turns');

  routeClaudeEvent(rl(0.52), on);
  assert.deepEqual(seen, [0.52], 'a rate_limit_event must reach the gate');
  assert.equal(ends, 0, 'a rate_limit_event arrives mid-turn and must not end it');

  routeClaudeEvent({ type: 'result' }, on);
  assert.equal(ends, 1);

  routeClaudeEvent({}, on);
  routeClaudeEvent({ type: undefined }, on);
  assert.equal(ends, 1, 'a malformed event must not end a turn');
});

test('a driver that reports NO usage is UNMETERED and says so, not "unknown" forever', async () => {
  // 🛑 Found by claude1 on PR 34. The gate answered `unknown` whenever no
  // snapshot had arrived, so a driver whose CLI reports no limits dispatched
  // with NO CEILING and nothing ever said so. The Cursor driver this seam
  // exists to enable is exactly that driver.
  const sent: string[] = [];
  const lines: string[] = [];
  let endTurn: (() => void) | undefined;

  const s = await startSupervisor(supervisorOptions({ extraDirs: SUPERVISOR_TEST_DIRS,
    handle: 'unmetered',
    log: (l) => lines.push(l),
    spawnChild: () => ({
      reportsUsage: false,
      reportsContext: true,
      send: (t) => sent.push(t),
      onTurnEnd: (cb) => {
        endTurn = cb;
      },
      onContext: () => undefined,
      onUsage: () => undefined,
      // 🛑 ADDED WHEN THE SEAM GREW. These fakes were silently incomplete —
      // the supervisor called `child.onSession` and every test threw. A fake
      // that does not implement the whole interface tests a child that
      // cannot exist.
      onDenial: () => undefined,
      onSession: () => undefined,
      onEvent: () => undefined,
      onExit: () => undefined,
      kill: () => undefined,
    }),
  }));

  try {
    // It still dispatches — unmetered is a CHOICE, not a refusal.
    assert.equal((await deliverToSupervisor('unmetered', env(1, 'x')))?.queued, 'sent');

    // But it ANNOUNCED itself at startup, before dispatching anything.
    assert.ok(
      lines.some((l) => /UNMETERED/.test(l)),
      `startup never said it was unmetered: ${lines.join(' | ')}`,
    );
    assert.ok(lines.some((l) => /NOTHING bounds dispatch/.test(l)));
    assert.ok(!lines.some((l) => /not yet observed/.test(l)), '"not yet" means never here');
    endTurn?.();
  } finally {
    await s.stop();
  }
});

test('a METERED driver says "not yet observed" at startup, which is a different thing', async () => {
  const f = fakeChild();
  const lines: string[] = [];
  const s = await startSupervisor(supervisorOptions({ extraDirs: SUPERVISOR_TEST_DIRS, handle: 'metered', spawnChild: () => f.child, log: (l) => lines.push(l) }));

  try {
    assert.ok(lines.some((l) => /not yet observed/.test(l)));
    assert.ok(!lines.some((l) => /UNMETERED/.test(l)));
  } finally {
    await s.stop();
  }
});

test('describe() HAS a production caller now — startup logs it', async () => {
  // It was reachable only from tests, the same dead-code shape the gate itself
  // had one commit earlier.
  const f = fakeChild();
  const lines: string[] = [];
  const s = await startSupervisor(supervisorOptions({ extraDirs: SUPERVISOR_TEST_DIRS, handle: 'logged', spawnChild: () => f.child, log: (l) => lines.push(l) }));

  try {
    assert.ok(lines.some((l) => /^rate limits:/.test(l)), 'startup must report the gate state');
  } finally {
    await s.stop();
  }
});

test('a driver that reports NO context announces the blank at startup and still dispatches', async () => {
  // #217. A blank gauge had two causes an operator could not tell apart: a
  // driver that reports no context at all, and reporting that broke. The
  // rate-limit side has said which since PR 34; this side said nothing.
  // lee, 2026-11-13: *"dispatch and announce the blank"*.
  const sent: string[] = [];
  const lines: string[] = [];
  let endTurn: (() => void) | undefined;

  const s = await startSupervisor(supervisorOptions({ extraDirs: SUPERVISOR_TEST_DIRS,
    handle: 'nocontext',
    log: (l) => lines.push(l),
    spawnChild: () => ({
      reportsUsage: true,
      reportsContext: false,
      send: (t) => sent.push(t),
      onTurnEnd: (cb) => {
        endTurn = cb;
      },
      onContext: () => undefined,
      onUsage: () => undefined,
      onDenial: () => undefined,
      onSession: () => undefined,
      onEvent: () => undefined,
      onExit: () => undefined,
      kill: () => undefined,
    }),
  }));

  try {
    // It still dispatches. A blank gauge is announced, never a refusal.
    assert.equal((await deliverToSupervisor('nocontext', env(1, 'x')))?.queued, 'sent');

    assert.ok(
      lines.some((l) => /UNREPORTED/.test(l)),
      `startup never said the gauge was unreported: ${lines.join(' | ')}`,
    );
    assert.ok(lines.some((l) => /context gauge:/.test(l)));
    endTurn?.();
  } finally {
    await s.stop();
  }
});

test('a driver that DOES report context says so at startup, and does not claim the blank', async () => {
  // 🛑 THE PAIRED CONTROL. A test covering only the `false` driver leaves the
  // `true` line unasserted, which is the dead-code shape `describe()` itself
  // was in before #213.
  const f = fakeChild();
  const lines: string[] = [];
  const s = await startSupervisor(supervisorOptions({ extraDirs: SUPERVISOR_TEST_DIRS, handle: 'hascontext', spawnChild: () => f.child, log: (l) => lines.push(l) }));

  try {
    assert.ok(lines.some((l) => /^context gauge:/.test(l)), 'startup must report the gauge state');
    assert.ok(!lines.some((l) => /UNREPORTED/.test(l)), 'a reporting driver is not unreported');
  } finally {
    await s.stop();
  }
});

/**
 * #217, raised by claude2 reviewing PR 218: counting the fakes fixes today's
 * 14 and not the 15th, written next month. `tsconfig.json` covers `src/**`
 * only, so a test fake or a JS driver that omits a capability reads
 * `undefined` — which is FALSY, so the supervisor would announce UNREPORTED
 * about a driver that never said anything. That is the exact "inferred from
 * silence" failure the flag exists to end, arriving through the back door.
 */
test('a driver that OMITS a capability fails fast, naming the field it omitted', async () => {
  // 🛑 TABLE-DRIVEN BECAUSE THE FIRST CUT WAS VACUOUS, and claude2 said so on
  // PR 218. It omitted BOTH fields and asserted /reportsUsage|reportsContext/,
  // so a guard checking only ONE of them passed. Each case below omits or
  // corrupts exactly one field, and asserts the message names THAT field and
  // NOT the other.
  const OTHER = { reportsUsage: 'reportsContext', reportsContext: 'reportsUsage' } as const;
  // ⚠️ HANDLES STAY SHORT. The handle becomes a unix socket path, and macOS
  // caps that at 104 bytes — a descriptive name threw `listen EINVAL` BEFORE
  // the guard ran, so the rejection assertion passed on the wrong error.
  let caseNo = 0;
  const BAD: readonly [string, unknown][] = [
    ['absent', undefined],
    ['null', null],
    ['a string', 'yes'],
    ['a number', 1],
  ];

  for (const field of ['reportsUsage', 'reportsContext'] as const) {
    for (const [label, value] of BAD) {
      const declared: Record<string, unknown> = { reportsUsage: true, reportsContext: true };

      if (value === undefined) delete declared[field];
      else declared[field] = value;

      const bare = () =>
        ({
          ...declared,
          send: () => undefined,
          onTurnEnd: () => undefined,
          onContext: () => undefined,
          onUsage: () => undefined,
          onDenial: () => undefined,
          onSession: () => undefined,
          onEvent: () => undefined,
          onExit: () => undefined,
          kill: () => undefined,
        }) as unknown as AgentChild;

      // ⚠️ THE `finally` IS NOT DECORATION. Before the guard existed this call
      // RESOLVED, leaving a live supervisor holding a socket, and the test
      // file hung with no failure line rather than failing. A rejection
      // assertion on something that allocates must still release it.
      let started: Awaited<ReturnType<typeof startSupervisor>> | undefined;
      const handle = `undecl${caseNo++}`;

      try {
        await assert.rejects(
          async () => {
            started = await startSupervisor(
              supervisorOptions({ extraDirs: SUPERVISOR_TEST_DIRS, handle, spawnChild: bare }),
            );
          },
          (err: Error) => {
            assert.match(err.message, new RegExp(field), `${field} ${label}: the message must name the offending field`);
            assert.doesNotMatch(
              err.message,
              new RegExp(OTHER[field]),
              `${field} ${label}: naming the OTHER field means the guard did not check this one`,
            );
            return true;
          },
        );
      } finally {
        await started?.stop();
      }
    }
  }
});

test('a failed start releases the socket, so one bad spawn is not a permanent one', async () => {
  // claude2, PR 218: the listener is bound BEFORE the child is spawned, so a
  // guard that throws at spawn must not leave the handle held.
  const bare = () =>
    ({
      send: () => undefined,
      onTurnEnd: () => undefined,
      onContext: () => undefined,
      onUsage: () => undefined,
      onDenial: () => undefined,
      onSession: () => undefined,
      onEvent: () => undefined,
      onExit: () => undefined,
      kill: () => undefined,
    }) as unknown as AgentChild;

  const opts = supervisorOptions({ extraDirs: SUPERVISOR_TEST_DIRS, handle: 'releasesock', spawnChild: bare });
  await assert.rejects(() => startSupervisor(opts));

  // The proof is that a GOOD driver can take the handle afterwards. A missing
  // socket file would also pass if the path were simply never created.
  const f = fakeChild();
  const s = await startSupervisor(
    supervisorOptions({ extraDirs: SUPERVISOR_TEST_DIRS, handle: 'releasesock', spawnChild: () => f.child }),
  );
  await s.stop();
});

test('a driver that DECLARES false is legal and still starts', async () => {
  // 🛑 THE PAIRED CONTROL, AND THE WHOLE DISTINCTION. lee ruled "dispatch and
  // announce the blank", so a declared `false` is a CHOICE. Only an ABSENT
  // declaration is the error. A guard that cannot tell them apart would
  // refuse the very driver #217 exists to support.
  const lines: string[] = [];
  const s = await startSupervisor(supervisorOptions({ extraDirs: SUPERVISOR_TEST_DIRS,
    handle: 'declaredfalse',
    log: (l) => lines.push(l),
    spawnChild: () => ({
      reportsUsage: false,
      reportsContext: false,
      send: () => undefined,
      onTurnEnd: () => undefined,
      onContext: () => undefined,
      onUsage: () => undefined,
      onDenial: () => undefined,
      onSession: () => undefined,
      onEvent: () => undefined,
      onExit: () => undefined,
      kill: () => undefined,
    }),
  }));

  try {
    assert.ok(lines.some((l) => /UNREPORTED/.test(l)), 'a declared false still announces');
    assert.ok(lines.some((l) => /UNMETERED/.test(l)));
  } finally {
    await s.stop();
  }
});
