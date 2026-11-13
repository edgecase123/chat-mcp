import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeSpawn } from '../../src/adapters/claude-spawn.js';

test('host mode passes the permission flags, never the container bypass', () => {
  const args = claudeSpawn.argsFor({}, 'host');

  assert.ok(args.includes('--permission-mode'));
  assert.ok(!args.includes('--allow-dangerously-skip-permissions'));
  assert.ok(!args.includes('--dangerously-skip-permissions'));
});

/**
 * 🛑 THIS TEST PINNED THE BUG FOR A WEEK. It asserted
 * `--allow-dangerously-skip-permissions` and passed, while every containerized
 * agent was denied every tool it tried to use.
 *
 * The two flags are NOT synonyms, and the CLI's own help says so:
 *
 *   --allow-dangerously-skip-permissions
 *       "Enable bypassing all permission checks AS AN OPTION, without it
 *        being enabled by default."
 *   --dangerously-skip-permissions
 *       "Bypass all permission checks."
 *
 * The first makes the bypass AVAILABLE. Only the second turns it ON. The
 * container passed the enabler alone, so permission checks still ran with
 * nothing there to answer them — and the agent's reply on the bus was
 * denied. It said so out loud and nothing was logging it.
 */
test('🛑 docker mode ENABLES the bypass AND TURNS IT ON', () => {
  const args = claudeSpawn.argsFor({}, 'docker');

  assert.ok(
    args.includes('--dangerously-skip-permissions'),
    'the bypass is available but never activated; every tool call will be denied',
  );
  // ⚠️ MEASURED. A live container with the activator ALONE answered on the
  // bus, so the enabler is redundant and is not passed.
  assert.ok(!args.includes('--allow-dangerously-skip-permissions'));
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
