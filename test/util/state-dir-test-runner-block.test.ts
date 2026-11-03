import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';

// This file deliberately does NOT redirect at module scope — the block under
// test is what happens when a test has not redirected.
const { stateDir } = await import('../../src/util/paths.js');

/**
 * 🛑 A TEST THAT RESOLVES THE DEFAULT STATE DIR CAN SILENCE A LIVE AGENT.
 *
 * `WakeListener.bind()` unlinks a socket it judges stale, and a live supervisor
 * merely slow to answer the probe looks the same as debris. Two test files did
 * exactly this, leaving 3582 files in the operator's real `~/.chat-mcp`.
 *
 * Ruled by lee: *"Block under NODE_TEST_CONTEXT, and throw naming
 * CHAT_MCP_HOME."* Neither of the two options the ticket offered — `node --test`
 * sets that variable and nothing else does, so a legitimate local tool keeps
 * the real path.
 */

/** Run `fn` with the named env vars forced, then restore exactly. */
function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved = new Map(Object.keys(vars).map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('🚨 under the test runner with no CHAT_MCP_HOME, stateDir THROWS', () => {
  // The premise: we really are under the runner.
  assert.notEqual(process.env.NODE_TEST_CONTEXT, undefined, 'this file must run under node --test');

  withEnv({ CHAT_MCP_HOME: undefined }, () => {
    assert.throws(() => stateDir(), /CHAT_MCP_HOME/, 'the error must name the variable to set');
  });
});

/** An empty string already counted as absent, and must keep counting as absent. */
test('🚨 an EMPTY CHAT_MCP_HOME is not a redirect either', () => {
  withEnv({ CHAT_MCP_HOME: '' }, () => {
    assert.throws(() => stateDir(), /CHAT_MCP_HOME/);
  });
});

test('🚨 with CHAT_MCP_HOME set, stateDir returns it and does not throw', () => {
  withEnv({ CHAT_MCP_HOME: '/tmp/chat-mcp-probe' }, () => {
    assert.equal(stateDir(), '/tmp/chat-mcp-probe');
  });
});

/**
 * 🛑 THE CONTROL THAT PROVES THE BLOCK IS SCOPED. Without it, a block that
 * fired everywhere would pass every assertion above — and break every real
 * `chat-mcp` invocation, which has no `CHAT_MCP_HOME` and should not need one.
 */
test('🚨 OUTSIDE the test runner, the default path still resolves', () => {
  withEnv({ CHAT_MCP_HOME: undefined, NODE_TEST_CONTEXT: undefined }, () => {
    assert.equal(stateDir(), join(homedir(), '.chat-mcp'));
  });
});
