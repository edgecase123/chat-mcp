import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename, isAbsolute } from 'node:path';
import { claudeArgs, writeClaudeMcpConfig } from '../../src/supervise/drivers/claude.js';
import { DEFAULT_ALLOWED, builtinsFrom } from '../../src/supervise/grant.js';

/**
 * 🛑 A SUPERVISED AGENT THAT CANNOT ACT IS A DOORBELL, NOT A BUS.
 *
 * The configuration below is ONE decision, not a bag of flags. `--mcp-config`
 * without `--strict-mcp-config` leaves the child reading the consuming
 * project's `.mcp.json`, which hardcodes a handle a live session already owns.
 *
 * ⚠️ THESE REPLACED A REPLY-ONLY SET, on lee's decision of 2026-10-31. The old
 * ones asserted `--tools ''` — every built-in disabled — which was right for an
 * agent that only answered on the bus and is incompatible with one that edits
 * files and runs tests.
 */

function withTempHome<T>(fn: (home: string) => T): T {
  const home = mkdtempSync(join(tmpdir(), 'chat-mcp-grant-'));
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

const grant = {
  handle: 'sup-claude2',
  configPath: '/tmp/x.json',
  allowed: DEFAULT_ALLOWED,
  available: builtinsFrom(DEFAULT_ALLOWED),
};

test('without a grant the child gets NONE of the four flags', () => {
  const args = claudeArgs({});

  for (const flag of ['--mcp-config', '--strict-mcp-config', '--tools', '--allowedTools']) {
    assert.ok(!args.includes(flag), `${flag} leaked into a plain spawn`);
  }
});

test('a grant passes all four flags, because any three of them do not work', () => {
  const args = claudeArgs({ grant });

  assert.ok(args.includes('--mcp-config'), 'the child has no chat server at all');
  assert.ok(args.includes('--strict-mcp-config'), 'the child inherits the project .mcp.json');
  assert.ok(args.includes('--tools'), 'no built-in tool surface is declared');
  assert.ok(args.includes('--allowedTools'), 'the tools exist but nothing is permitted');
});

/**
 * 🛑 THIS IS THE GUARD, NOT A STYLE CHECK. `--mcp-config` alone ADDS to the
 * servers already configured for that cwd. The project's `.mcp.json` carries
 * `--handle claude2`, so a child spawned there registers as `claude2` and
 * fights the live session. `WakeListener.bind` refuses a live socket rival;
 * MCP registration has no such guard. See chat-mcp#35.
 */
test('--strict-mcp-config and --mcp-config travel together or not at all', () => {
  const args = claudeArgs({ grant });

  assert.equal(
    args.includes('--mcp-config'),
    args.includes('--strict-mcp-config'),
    'the two flags must travel together or the child steals a live handle',
  );
});

/**
 * 🛑 THE BUILT-IN SURFACE MUST COVER EVERY ALLOWLIST ENTRY, OR AN ENTRY NAMES A
 * TOOL THAT DOES NOT EXIST AND THE CHILD SIMPLY CANNOT RUN IT. That failure is
 * silent: the allowlist looks generous and the agent looks incapable.
 */
test('every allowed built-in is also declared available', () => {
  const args = claudeArgs({ grant });
  const toolsIdx = args.indexOf('--tools');
  const allowedIdx = args.indexOf('--allowedTools');

  assert.notEqual(toolsIdx, -1, 'no --tools flag, so this test proves nothing');
  assert.ok(allowedIdx > toolsIdx, 'expected --allowedTools after --tools');

  const available = args.slice(toolsIdx + 1, allowedIdx);
  const needed = DEFAULT_ALLOWED.filter((t) => !t.startsWith('mcp__')).map((t) =>
    t.replace(/\(.*$/, ''),
  );

  for (const tool of new Set(needed)) {
    assert.ok(available.includes(tool), `allowlisted but not available: ${tool}`);
  }
});

test('Bash is available, because the allowlist scopes Bash commands', () => {
  assert.ok(
    DEFAULT_ALLOWED.some((t) => t.startsWith('Bash(')),
    'no Bash(...) entries, so this test proves nothing',
  );
  assert.ok(builtinsFrom(DEFAULT_ALLOWED).includes('Bash'));
});

test('an MCP tool is allowed but never declared as a built-in', () => {
  const builtins = builtinsFrom(DEFAULT_ALLOWED);

  assert.deepEqual(
    builtins.filter((t) => t.startsWith('mcp__')),
    [],
    '`--tools` governs built-ins only; an MCP tool there is meaningless',
  );
  assert.ok(
    DEFAULT_ALLOWED.some((t) => t.startsWith('mcp__chat__')),
    'the child cannot answer on the bus at all',
  );
});

test('the allowlist the child receives is the one it was given, verbatim', () => {
  const args = claudeArgs({ grant });
  const allowed = args[args.indexOf('--allowedTools') + 1]!.split(',');

  assert.deepEqual(allowed, [...DEFAULT_ALLOWED]);
});

/**
 * 🛑 THE MODE IS PART OF THE COMBINATION. `plan` DENIES tool use outright,
 * measured on chat-mcp#33 — the child woke, understood it was on the bus,
 * tried to answer and was refused. The flags are useless without this.
 */
test('a child with a grant does not default to the mode that denies everything', () => {
  const args = claudeArgs({ grant });

  assert.notEqual(args[args.indexOf('--permission-mode') + 1], 'plan');
});

test('a child with no grant still defaults to plan', () => {
  const args = claudeArgs({});

  assert.equal(args[args.indexOf('--permission-mode') + 1], 'plan');
});

test('an explicit permission mode wins over both defaults', () => {
  const args = claudeArgs({ permissionMode: 'plan', grant });

  assert.equal(args[args.indexOf('--permission-mode') + 1], 'plan');
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
 * 🛑 THE FIELD THAT WAS WRONG WAS THE ONE NOTHING ASSERTED. The generated
 * config named the right handle and launched the WRONG PROGRAM.
 * `process.argv[1]` was used to mean "the chat-mcp entry point"; it means
 * "whatever script is running now". Found by the live harness, which was the
 * only thing that could — every other test here checked the handle.
 */
test('the generated config launches a file that EXISTS', () => {
  withTempHome(() => {
    const path = writeClaudeMcpConfig('sup-claude2');
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      mcpServers: { chat: { command: string; args: string[] } };
    };

    const script = parsed.mcpServers.chat.args.find((a) => a.endsWith('.js') || a.endsWith('.ts'));

    assert.ok(script, 'the config names no script at all');
    assert.ok(existsSync(script), `the child would launch a file that is not there: ${script}`);
  });
});

test("the generated config launches chat-mcp's ENTRY, not the running script", () => {
  withTempHome(() => {
    const path = writeClaudeMcpConfig('sup-claude2');
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      mcpServers: { chat: { command: string; args: string[] } };
    };

    const script = parsed.mcpServers.chat.args.find((a) => a.endsWith('.js') || a.endsWith('.ts'));

    assert.match(
      basename(script!),
      /^index\.(js|ts)$/,
      'the child is being pointed at something that is not the CLI entry',
    );
    assert.notEqual(script, process.argv[1], 'still using the running script as the entry');
  });
});

test('a TypeScript entry is launched with a loader, a JavaScript one is not', () => {
  withTempHome(() => {
    const path = writeClaudeMcpConfig('sup-claude2');
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      mcpServers: { chat: { command: string; args: string[] } };
    };

    const args = parsed.mcpServers.chat.args;
    const script = args.find((a) => a.endsWith('.js') || a.endsWith('.ts'))!;

    if (script.endsWith('.ts')) {
      assert.ok(args.includes('--import'), 'a .ts entry needs a loader or the child dies at once');
    } else {
      assert.ok(!args.includes('--import'), 'a .js entry needs no loader');
    }
  });
});

/**
 * 🛑 THE GENERALISED FORM OF TWO SEPARATE BUGS, BOTH SHIPPED IN ONE HOUR.
 * First the script path came from `process.argv[1]`. Then the script path was
 * absolute but the LOADER was the bare specifier `tsx`, which the child
 * resolves from ITS OWN cwd — and the live harness uses an empty temp dir with
 * no `node_modules` above it, so the chat server died with
 * ERR_MODULE_NOT_FOUND the instant it started.
 */
test('every path in the generated command is absolute, because the child has a different cwd', () => {
  withTempHome(() => {
    const path = writeClaudeMcpConfig('sup-claude2');
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      mcpServers: { chat: { command: string; args: string[] } };
    };

    const { command, args } = parsed.mcpServers.chat;

    assert.ok(isAbsolute(command), `the interpreter is not an absolute path: ${command}`);

    const flags = new Set(['--import', '--handle']);

    for (const [i, a] of args.entries()) {
      if (flags.has(a)) continue;
      if (args[i - 1] === '--handle') continue;

      assert.ok(isAbsolute(a), `argument ${i} is relative and resolves in the CHILD's cwd: ${a}`);
    }
  });
});

/**
 * 🛑 THE REGISTRY IS THE WHOLE POINT OF THE SPLIT. Before it,
 * `startSupervisor` imported `spawnClaude` by name — everything else was
 * already behind the seam, so that one line was the entire remaining coupling.
 */
test('the driver registry knows claude and refuses an unknown name', async () => {
  const { driverFor, DRIVER_NAMES } = await import('../../src/supervise/drivers/index.js');

  assert.ok(DRIVER_NAMES.includes('claude'), 'the only driver that exists is not registered');

  const claude = driverFor('claude');
  assert.equal(typeof claude.spawn, 'function');

  // 🛑 The re-dispatch wording travels WITH the driver. A seam test caught it
  // living above the driver, where it named Claude Code's own flag.
  assert.equal(typeof claude.redispatchPrompt, 'function');

  // 🛑 A silent fallback would mean asking for Cursor and getting Claude,
  // which looks exactly like Cursor working.
  assert.throws(() => driverFor('cursor'), /unknown agent driver "cursor"/);
});

/**
 * 🛑 NOTHING ABOVE THE DRIVER DIRECTORY MAY NAME A CLI'S EVENT SHAPES OR FLAGS.
 * Read from the source text, because a type error cannot catch a string.
 */
test('no module above drivers/ knows any CLI event shape or flag', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const { join } = await import('node:path');

  const dir = new URL('../../src/supervise/', import.meta.url).pathname;
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));

  assert.ok(files.length > 5, `expected the supervise modules, found ${files.length}`);

  const forbidden = [
    "'rate_limit_event'",
    "'result'",
    'Permission for this tool use was denied',
    'stream-json',
    '--allowedTools',
  ];

  const leaks: string[] = [];

  for (const file of files) {
    // Strip comments: the history of these bugs is documented in prose and
    // that prose is allowed to quote the shapes.
    const code = readFileSync(join(dir, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    for (const needle of forbidden) {
      if (code.includes(needle)) leaks.push(`${file}: ${needle}`);
    }
  }

  assert.deepEqual(leaks, [], 'a CLI specific lives above the driver directory');
});
