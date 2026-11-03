import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 🛑 BEFORE any import that resolves a state path. `stateDir()` refuses the
// default under the test runner, so this is required, not merely tidy.
process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), 'chat-mcp-wake-'));

const { activeWakeTransport, fileWatchTransport, registerWakeTransport } = await import(
  '../../src/notify/transport.js'
);
const { buildAdditionalContext } = await import('../../src/adapters/claude-code.js');

/**
 * 🛑 THE POINT IS THE SEAM, NOT THE DEFAULT.
 *
 * Indirection that only ever returns the file watch proves nothing. The test
 * that matters registers a transport which is NOT a file watch and asserts
 * the adapter's output follows it, with no trace of the old mechanism.
 */

const FAKE = {
  id: 'test-socket',
  summary: (h: string) => `Wakes for "${h}" arrive on a socket`,
  subscribe: (h: string) => ({
    kind: 'process' as const,
    command: `fake-listen --handle ${h}`,
    description: `socket wake for ${h}`,
    timeoutMs: 1234,
  }),
};

function withTransport<T>(id: string, fn: () => T): T {
  const before = process.env.CHAT_MCP_WAKE_TRANSPORT;
  process.env.CHAT_MCP_WAKE_TRANSPORT = id;
  try { return fn(); } finally {
    if (before === undefined) delete process.env.CHAT_MCP_WAKE_TRANSPORT;
    else process.env.CHAT_MCP_WAKE_TRANSPORT = before;
  }
}

test('the default transport is the file watch, so nothing changes for existing hosts', () => {
  assert.equal(activeWakeTransport().id, 'file-watch');
  const sub = fileWatchTransport.subscribe('alice');
  assert.match(sub.command, /require\('fs'\)/);
  assert.match(sub.command, /fs\.watch\(p/);
  assert.match(sub.endpoint ?? '', /alice$/);
});

test('the REAL default block still parses and still arms the file watch', () => {
  // The thing every existing Claude Code session actually consumes. A seam
  // that quietly changed this would break the wake for every current host.
  const text = buildAdditionalContext('claude2');
  const json = text.split('```json')[1]?.split('```')[0] ?? '';
  const parsed = JSON.parse(json) as { command: string; description: string; timeout_ms: number };

  assert.match(parsed.command, /^node -e "const fs=require\('fs'\),p='.*\/claude2';/);
  assert.equal(parsed.description, 'chat-mcp inbound for claude2');
  // 🛑 THE HOST'S CAP, NOT AN HOUR. Monitor caps at 30 minutes, so an hour
  // printed here made the watch die at half its advertised life.
  assert.equal(parsed.timeout_ms, 1800000);
  assert.doesNotMatch(parsed.command, /console\.log\('wake'\)/, 'a bare wake cannot be triaged');
});

test('🛑 the hook does NOT pass `persistent`, which is not a Monitor parameter', () => {
  const text = buildAdditionalContext('claude2');
  const json = text.split('```json')[1]?.split('```')[0] ?? '';
  assert.doesNotMatch(json, /persistent/);
  // The denominator: the block still carries the three real parameters.
  const parsed = JSON.parse(json) as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed).sort(), ['command', 'description', 'timeout_ms']);
});

test('🛑 the duplicate check comes BEFORE the block it guards', () => {
  // An instruction that says FIRST and is read second is not a guard. The
  // hook is consumed top to bottom, so position is the whole of its effect.
  const text = buildAdditionalContext('claude2');
  const check = text.indexOf('FIRST, count the watchers');
  const block = text.indexOf('```json');
  assert.notEqual(check, -1, 'the check is missing');
  assert.ok(check < block, `check at ${check} must precede the json block at ${block}`);
  assert.match(text, /\/clear/, 'the reason has to name the trigger or it reads as optional');
  assert.match(text, /must NOT arm a second/);
  // 🛑 THE COUNT IS THE FIRST TOOL CALL NOW, so the hook must not still claim
  // the Monitor is. It said "your very first tool call" while asking for a
  // `ps` run before it, which is two different first things.
  assert.match(text, /That count is your first tool call/);
  assert.doesNotMatch(text, /as your very first tool call/);
});

test('the file-watch transport supplies a probe at all', () => {
  const probe = fileWatchTransport.subscribe('claude2').probeCommand;
  assert.ok(probe, 'without one the adapter has nothing to print');
  // 🛑 THIS IS NOT THE SEAM GUARD. For the file watch, a probe rebuilt from
  // `endpoint` is byte-identical to the transport's own, so an `includes`
  // check here passes either way. Measured against the pre-fix file. The seam
  // guard is the test below, which uses a probe that cannot be rebuilt.
  assert.ok(buildAdditionalContext('claude2').includes(probe!));
});

test('🛑 THE SEAM: the probe comes from the TRANSPORT, not rebuilt from `endpoint`', () => {
  // transport.ts says adapters "must not reconstruct the command from it".
  // This transport has an endpoint AND a probe that no reconstruction could
  // produce, so rebuilding is visible here and nowhere else.
  registerWakeTransport({
    id: 'probe-seam',
    summary: (h: string) => `wakes for ${h}`,
    subscribe: (h: string) => ({
      kind: 'process' as const,
      command: `listen --handle ${h}`,
      description: `wake for ${h}`,
      timeoutMs: 1234,
      endpoint: `/tmp/seam/${h}`,
      probeCommand: `count-listeners --handle ${h}`,
    }),
  });
  const text = withTransport('probe-seam', () => buildAdditionalContext('alice'));

  assert.match(text, /count-listeners --handle alice/, 'the transport\'s probe is missing');
  assert.doesNotMatch(text, /ps -axo/, 'the adapter rebuilt a file-watch probe');
  assert.doesNotMatch(text, /\^node/);
});

test('🛑 the probe anchors on ^node, or it counts the shell and itself', () => {
  // Measured on this machine: without the anchor the count reads 2 where one
  // watcher is mine, because the watcher's parent shell matches too. The agent
  // then sees "already armed" and never arms anything.
  const probe = fileWatchTransport.subscribe('claude2').probeCommand!;
  assert.match(probe, /grep -c "\^node -e\.\*/);
});

test('🛑 the probe is RIGHT-anchored, or a handle counts its own PREFIX siblings', () => {
  // Measured with two live watchers: unanchored, the pattern for `rw` counts
  // 2 because it matches rw2's command too. `rw` and `rw2` both have
  // installed adapters, so a prefix pair exists on this machine today.
  const probe = fileWatchTransport.subscribe('rw').probeCommand!;
  assert.match(probe, /\/rw'"$/, 'the pattern must end at the handle, not run on');

  const sibling = fileWatchTransport.subscribe('rw2').probeCommand!;
  // The denominator: the two probes must not be prefixes of one another.
  assert.ok(!sibling.includes(probe.replace(/"$/, '')), 'rw2 still matches the rw pattern');
});

test('🛑 a transport with NO probe gets no invented one', () => {
  registerWakeTransport(FAKE);
  const text = withTransport('test-socket', () => buildAdditionalContext('alice'));

  assert.doesNotMatch(text, /ps -axo/, 'a file-watch probe leaked into a socket transport');
  assert.doesNotMatch(text, /\^node/);
  // It must still forbid a duplicate, just without a command it cannot write.
  assert.match(text, /do NOT arm a second one/);
});

test('🛑 the adapter CLAMPS to the host cap, and the transport keeps asking', () => {
  // The transport's request and the host's limit are different facts. Monitor
  // caps at 30 minutes; printing an unclamped hour is what killed the watch.
  assert.equal(fileWatchTransport.subscribe('claude2').timeoutMs, 3_600_000);

  const json = buildAdditionalContext('claude2').split('```json')[1]?.split('```')[0] ?? '';
  assert.equal((JSON.parse(json) as { timeout_ms: number }).timeout_ms, 1_800_000);
});

test('a request BELOW the cap is printed unchanged', () => {
  // The denominator for the clamp: it must not pin every transport to 30m.
  registerWakeTransport(FAKE);
  const text = withTransport('test-socket', () => buildAdditionalContext('alice'));
  const json = text.split('```json')[1]?.split('```')[0] ?? '';
  assert.equal((JSON.parse(json) as { timeout_ms: number }).timeout_ms, 1234);
});

test('an unknown transport name falls back rather than leaving a host with no wake', () => {
  withTransport('no-such-transport', () => {
    assert.equal(activeWakeTransport().id, 'file-watch');
  });
});

test('THE SEAM: swapping the transport changes the adapter, and the file watch disappears', () => {
  registerWakeTransport(FAKE);

  const before = buildAdditionalContext('alice');
  assert.match(before, /fs\.watch\(p/, 'default should still be the file watch');

  const after = withTransport('test-socket', () => buildAdditionalContext('alice'));

  assert.match(after, /fake-listen --handle alice/);
  assert.match(after, /socket wake for alice/);
  assert.match(after, /"timeout_ms": 1234/);
  assert.match(after, /Wakes for "alice" arrive on a socket/);
  // THE ASSERTION THAT MATTERS. Indirection would leave this behind.
  assert.doesNotMatch(after, /fs\.watch\(/);
  assert.doesNotMatch(after, /\.chat-mcp\/notify/);
});

test('the adapter emits a valid JSON block whatever the transport says', () => {
  registerWakeTransport(FAKE);
  const text = withTransport('test-socket', () => buildAdditionalContext('alice'));
  const json = text.split('```json')[1]?.split('```')[0] ?? '';
  const parsed = JSON.parse(json) as { command: string; timeout_ms: number };

  assert.equal(parsed.command, 'fake-listen --handle alice');
  assert.equal(parsed.timeout_ms, 1234);
});
