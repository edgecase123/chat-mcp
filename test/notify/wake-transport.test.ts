import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  activeWakeTransport,
  fileWatchTransport,
  registerWakeTransport,
} from '../../src/notify/transport.js';
import { buildAdditionalContext } from '../../src/adapters/claude-code.js';

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
  assert.match(sub.command, /fs'\)\.watch\(/);
  assert.match(sub.endpoint ?? '', /alice$/);
});

test('the REAL default block still parses and still arms the file watch', () => {
  // The thing every existing Claude Code session actually consumes. A seam
  // that quietly changed this would break the wake for every current host.
  const text = buildAdditionalContext('claude2');
  const json = text.split('```json')[1]?.split('```')[0] ?? '';
  const parsed = JSON.parse(json) as { command: string; description: string; timeout_ms: number };

  assert.match(parsed.command, /^node -e "require\('fs'\)\.watch\('.*\/claude2', \(\) => console\.log\('wake'\)\)"$/);
  assert.equal(parsed.description, 'chat-mcp inbound for claude2');
  assert.equal(parsed.timeout_ms, 3600000);
});

test('an unknown transport name falls back rather than leaving a host with no wake', () => {
  withTransport('no-such-transport', () => {
    assert.equal(activeWakeTransport().id, 'file-watch');
  });
});

test('THE SEAM: swapping the transport changes the adapter, and the file watch disappears', () => {
  registerWakeTransport(FAKE);

  const before = buildAdditionalContext('alice');
  assert.match(before, /fs'\)\.watch\(/, 'default should still be the file watch');

  const after = withTransport('test-socket', () => buildAdditionalContext('alice'));

  assert.match(after, /fake-listen --handle alice/);
  assert.match(after, /socket wake for alice/);
  assert.match(after, /"timeout_ms": 1234/);
  assert.match(after, /Wakes for "alice" arrive on a socket/);
  // THE ASSERTION THAT MATTERS. Indirection would leave this behind.
  assert.doesNotMatch(after, /fs'\)\.watch\(/);
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
