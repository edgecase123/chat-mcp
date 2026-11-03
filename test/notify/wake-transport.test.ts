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
  assert.match(text, /If that count is zero, then as your very first tool call/);
});

test('🛑 the duplicate-check command anchors on ^node, or it counts itself', () => {
  // Measured: without the anchor the count also matches the watcher's parent
  // shell and the grep process, so a first-ever session reads 2 and declines
  // to arm anything at all.
  const text = buildAdditionalContext('claude2');
  assert.match(text, /grep -c '\^node -e\.\*/);
  assert.match(text, /The `\^node` anchor is load-bearing/);
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
