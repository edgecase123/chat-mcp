import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { claudeArgs, writeClaudeMcpConfig } from '../../src/supervise/child.js';
import { DEFAULT_REPLY_TOOLS } from '../../src/supervise/bus-reply.js';

/**
 * 🛑 A SUPERVISED AGENT THAT CANNOT REPLY IS A DOORBELL, NOT A BUS.
 *
 * The supervisor woke an idle agent and the agent's correct action — answering
 * on the bus — was denied, because `plan` mode blocks `mcp__chat__send`. So
 * delivery was proven and conversation was not.
 *
 * The combination below is the one measured to work on chat-mcp#33. It is a
 * COMBINATION: `--mcp-config` without `--strict-mcp-config` leaves the child
 * reading the project's own `.mcp.json`, and that file hardcodes a handle a
 * live session is already using.
 */

function withTempHome<T>(fn: (home: string) => T): T {
  const home = mkdtempSync(join(tmpdir(), 'chat-mcp-bus-reply-'));
  const previous = process.env.CHAT_MCP_HOME;
  process.env.CHAT_MCP_HOME = home;

  try {
    return fn(home);
  } finally {
    if (previous === undefined) delete process.env.CHAT_MCP_HOME;
    else process.env.CHAT_MCP_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
}

test('without busReply the child gets NONE of the reply flags', () => {
  const args = claudeArgs({});

  for (const flag of ['--mcp-config', '--strict-mcp-config', '--tools', '--allowedTools']) {
    assert.ok(!args.includes(flag), `${flag} leaked into a plain spawn`);
  }
});

test('busReply passes all four flags, because any three of them do not work', () => {
  const args = claudeArgs({
    busReply: { handle: 'sup-claude2', configPath: '/tmp/x.json', tools: ['mcp__chat__send'] },
  });

  assert.ok(args.includes('--mcp-config'), 'the child has no chat server at all');
  assert.ok(args.includes('--strict-mcp-config'), 'the child inherits the project .mcp.json');
  assert.ok(args.includes('--tools'), 'every built-in tool stays available');
  assert.ok(args.includes('--allowedTools'), 'the chat tool is present but not permitted');
});

/**
 * 🛑 THIS IS THE GUARD, NOT A STYLE CHECK. `--mcp-config` alone ADDS to the
 * servers already configured for that cwd. The project's `.mcp.json` carries
 * `--handle claude2`, so a child spawned there registers as `claude2` and
 * fights the live session. `WakeListener.bind` refuses a live socket rival;
 * MCP registration has no such guard. See chat-mcp#35.
 */
test('--strict-mcp-config is never passed without --mcp-config, and never omitted with it', () => {
  const withReply = claudeArgs({
    busReply: { handle: 'sup-claude2', configPath: '/tmp/x.json', tools: ['mcp__chat__send'] },
  });

  assert.equal(
    withReply.includes('--mcp-config'),
    withReply.includes('--strict-mcp-config'),
    'the two flags must travel together or the child steals a live handle',
  );
});

test('--tools is given an EMPTY value, so no built-in tool survives', () => {
  const args = claudeArgs({
    busReply: { handle: 'sup-claude2', configPath: '/tmp/x.json', tools: ['mcp__chat__send'] },
  });

  assert.equal(args[args.indexOf('--tools') + 1], '', 'a non-empty --tools re-enables built-ins');
});

/**
 * ⚠️ Asserting "Bash is absent" against the allowlist alone is vacuous — it
 * would pass on a list that never mentioned Bash because the flag was dropped.
 * So assert the flag is PRESENT first, then that its value is only chat tools.
 */
test('the allowlist contains chat tools and nothing that can touch the machine', () => {
  const args = claudeArgs({
    busReply: {
      handle: 'sup-claude2',
      configPath: '/tmp/x.json',
      tools: [...DEFAULT_REPLY_TOOLS],
    },
  });

  const idx = args.indexOf('--allowedTools');
  assert.notEqual(idx, -1, 'the allowlist flag is missing, so this test proves nothing');

  const allowed = args[idx + 1]!.split(',');

  assert.ok(allowed.length > 0, 'an empty allowlist denies the reply it exists to permit');
  assert.deepEqual(
    allowed.filter((t) => !t.startsWith('mcp__chat__')),
    [],
    'a non-chat tool is allowlisted',
  );
});

test('the default allowlist permits a DM and a room post, and no third thing', () => {
  assert.deepEqual([...DEFAULT_REPLY_TOOLS], ['mcp__chat__send', 'mcp__chat__room_send']);
});

/**
 * 🛑 THE CHILD'S HANDLE IS NOT THE SUPERVISOR'S. A supervisor for `claude2`
 * that spawned a child also calling itself `claude2` would have the child
 * consume the messages the supervisor is trying to deliver to it.
 */
test('the written config registers the CHILD handle it was given', () => {
  withTempHome(() => {
    const path = writeClaudeMcpConfig('sup-claude2');
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      mcpServers: Record<string, { args: string[] }>;
    };

    const entry = parsed.mcpServers.chat;
    assert.ok(entry, 'no chat server in the generated config');

    const handleIdx = entry.args.indexOf('--handle');
    assert.notEqual(handleIdx, -1, 'the generated config names no handle at all');
    assert.equal(entry.args[handleIdx + 1], 'sup-claude2');
  });
});

/**
 * ⚠️ The generated file must not be the project's own `.mcp.json`. Writing
 * there would mutate the consuming repo, and `--strict-mcp-config` would then
 * be pointing at the very file it exists to exclude.
 */
test('the config is written under the chat-mcp state dir, not into any repo', () => {
  withTempHome((home) => {
    const path = writeClaudeMcpConfig('sup-claude2');

    assert.ok(path.startsWith(home), `config escaped the state dir: ${path}`);
    assert.ok(!path.endsWith('.mcp.json'), 'this is the filename the project uses');
  });
});

test('two handles get two different config files', () => {
  withTempHome(() => {
    assert.notEqual(writeClaudeMcpConfig('sup-claude1'), writeClaudeMcpConfig('sup-claude2'));
  });
});

/**
 * 🛑 THE MODE IS PART OF THE COMBINATION. `plan` denies `mcp__chat__send`,
 * measured on chat-mcp#33 — the child woke, read the project's CLAUDE.md,
 * understood it was on the bus, tried to answer and was refused. The flags
 * above are useless without this.
 */
test('a reply-capable child does not default to the mode that denies the reply', () => {
  const args = claudeArgs({
    busReply: { handle: 'sup-claude2', configPath: '/tmp/x.json', tools: ['mcp__chat__send'] },
  });

  assert.notEqual(args[args.indexOf('--permission-mode') + 1], 'plan');
});

test('a child with no reply permission still defaults to plan', () => {
  assert.equal(claudeArgs({}) [claudeArgs({}).indexOf('--permission-mode') + 1], 'plan');
});

test('an explicit permission mode wins over both defaults', () => {
  const args = claudeArgs({
    permissionMode: 'plan',
    busReply: { handle: 'sup-claude2', configPath: '/tmp/x.json', tools: ['mcp__chat__send'] },
  });

  assert.equal(args[args.indexOf('--permission-mode') + 1], 'plan');
});
