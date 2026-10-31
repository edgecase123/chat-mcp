import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename, isAbsolute } from 'node:path';
import { claudeArgs, writeClaudeMcpConfig } from '../../src/supervise/drivers/claude.js';
import { availableBuiltins, builtinsFrom } from '../../src/supervise/grant.js';
import { allowlistFor } from '../../src/supervise/allowlist.js';

const TEST_DIRS = ['/Users/leejenkins/dev/chat-mcp2'];
const DEFAULT_ALLOWED = allowlistFor(TEST_DIRS);


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
  available: availableBuiltins(DEFAULT_ALLOWED),
  extraDirs: TEST_DIRS,
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
 * 🛑 THE PREVIOUS VERSION OF THIS TEST COULD NEVER SEE DRIFT. It recomputed
 * the expected set with the same regex `builtinsFrom` uses, so a bug in that
 * function appeared identically on both sides and the assertion passed.
 * Found by claude1 reviewing PR 34.
 *
 * The expected values are now LITERAL.
 */
test('builtinsFrom strips the specifier and drops MCP tools — against fixed values', () => {
  assert.deepEqual(builtinsFrom(['Read', 'Bash(git commit:*)', 'mcp__chat__send', 'Edit(/a/**)']), [
    'Read',
    'Bash',
    'Edit',
  ]);
});

test('builtinsFrom de-duplicates, so two Bash rules do not yield two Bash entries', () => {
  assert.deepEqual(builtinsFrom(['Bash(git add:*)', 'Bash(git commit:*)']), ['Bash']);
});

/**
 * 🛑 `available` IS A SUPERSET OF WHAT THE ALLOWLIST IMPLIES, BY DESIGN, AND
 * AN EQUALITY TEST HERE WOULD FORCE A SECURITY HOLE BACK.
 *
 * `Write` and `Edit` must EXIST or an `Edit(<glob>)` scope has nothing to
 * permit — but allowlisting them BARE is what made the scopes decorative and
 * let a supervised agent edit any file on the machine.
 */
test('every built-in the allowlist implies is available, and Write/Edit are available too', () => {
  const available = availableBuiltins(DEFAULT_ALLOWED);

  for (const implied of builtinsFrom(DEFAULT_ALLOWED)) {
    assert.ok(available.includes(implied), `allowlisted but not available: ${implied}`);
  }

  for (const scoped of ['Write', 'Edit']) {
    assert.ok(available.includes(scoped), `${scoped} must exist for Edit(<glob>) to permit it`);
  }
});

/**
 * 🚨 CONTAINMENT NEEDS BOTH HALVES, AND EACH HALF ALONE WAS TRIED AND FAILED.
 *
 * Measured 2026-10-31, cwd held constant at `~/dev/chat-mcp2`:
 *
 *   bare `Write`,`Edit` + --add-dir      -> edited /tmp. ANY path.
 *   `Edit(<glob>)` + --add-dir           -> edited ~/playground, DENIED /tmp
 *
 * The rules say WHICH PATHS. The directories make those paths reachable at
 * all. An earlier reading blamed the cwd alone and was comparing two runs
 * that differed in two variables.
 */
test('no file-editing tool is allowlisted BARE — a bare entry reaches any path', () => {
  for (const bare of ['Write', 'Edit']) {
    assert.ok(!DEFAULT_ALLOWED.includes(bare), `a bare '${bare}' edited /tmp when measured`);
  }
});

test('the allowlist carries Edit scopes, or nothing can edit at all', () => {
  const scopes = DEFAULT_ALLOWED.filter((t) => t.startsWith('Edit('));

  assert.ok(scopes.length > 0, 'file editing was asked for and no scope grants it');
});

/**
 * 🛑 THE TWO HALVES MUST NAME THE SAME DIRECTORIES. A scope for a directory
 * that is not reachable is denied; a reachable directory with no scope is
 * denied too. Either mismatch looks like "the agent cannot edit" with no clue
 * which half is wrong.
 */
test('every Edit scope has a matching reachable directory, and vice versa', () => {
  const scoped = DEFAULT_ALLOWED.filter((t) => t.startsWith('Edit(')).map((t) =>
    t.slice('Edit('.length, -'/**)'.length),
  );

  assert.deepEqual([...scoped].sort(), [...TEST_DIRS].sort());
});

/**
 * 🛑 THE DIRECTORIES ARE PATHS, NOT A FLAG. Claude Code spells this
 * `--add-dir`; Cursor will spell it differently or not at all. A driver that
 * ignores them yields a NARROWER agent, never a wider one.
 */
test('the grant carries directories and the driver renders the flag', () => {
  const args = claudeArgs({ grant });
  const idx = args.indexOf('--add-dir');

  assert.notEqual(idx, -1, 'the driver never renders the directories');
  assert.equal(args[idx + 1], TEST_DIRS[0]);

  for (const dir of grant.extraDirs) {
    assert.ok(!dir.startsWith('-'), `a flag leaked into the path list: ${dir}`);
  }
});

test('a grant with no extra directories passes no --add-dir at all', () => {
  const args = claudeArgs({ grant: { ...grant, extraDirs: [] } });

  assert.ok(!args.includes('--add-dir'), 'an empty list emitted a valueless flag');
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
/**
 * 🚨 "NOT plan" WAS TOO WEAK, AND acceptEdits PASSED IT WHILE BREAKING THE
 * ALLOWLIST. Measured 2026-10-31, cwd and allowlist held constant:
 *
 *   acceptEdits + allowlist WITHOUT Bash  -> the rm RAN
 *   manual      + allowlist WITHOUT Bash  -> the rm was DENIED
 *
 * `acceptEdits` auto-approves inside the allowed directories and never
 * consults the list, so lee's narrow allowlist was decorative and nothing
 * was ever blocked — which is why the approval path could not fire. The mode
 * is NAMED here so a revert is visible rather than silent.
 */
test('a child with a grant defaults to manual, the mode that enforces the allowlist', () => {
  const args = claudeArgs({ grant });

  assert.equal(args[args.indexOf('--permission-mode') + 1], 'manual');
});

test('an allowlisted MCP tool is still permitted under that mode', () => {
  // Measured live: `mcp__chat__send` landed on the bus under BOTH modes, so
  // manual does not mute the child. Recorded as the reason the switch is safe.
  assert.ok(
    DEFAULT_ALLOWED.some((t) => t.startsWith('mcp__chat__')),
    'the child has no bus tool at all, so the mode choice is moot',
  );
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

/**
 * 🚨 THE EXISTING CHECKS PASSED ON THE WRONG FILE. They asserted the target
 * EXISTS and is named `index.(js|ts)` — and `src/supervise/index.ts`, the
 * SUPERVISOR, satisfies both. A one-level path error pointed every child's
 * MCP server at the supervisor, which exits immediately, so every child
 * reported `chat: failed, Connection closed` and had no bus tools at all.
 *
 * Two live e2e runs were misdiagnosed before this was found. "Named like the
 * entry" is not "is the entry".
 */
test('the generated config launches the CLI, not some other file called index', () => {
  withTempHome(() => {
    const path = writeClaudeMcpConfig('sup-claude2');
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      mcpServers: { chat: { args: string[] } };
    };

    const script = parsed.mcpServers.chat.args.find((a) => a.endsWith('.js') || a.endsWith('.ts'))!;
    const source = readFileSync(script, 'utf8');

    // The CLI registers subcommands and the shim fallback. The supervisor
    // does neither, so this distinguishes them by CONTENT, not by name.
    assert.ok(
      source.includes('KNOWN_SUBCOMMANDS') || source.includes("command('supervise"),
      `that is not the chat-mcp CLI entry: ${script}`,
    );
    assert.ok(
      !/export async function startSupervisor/.test(source),
      `that is the SUPERVISOR, not the CLI: ${script}`,
    );
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

/**
 * 🛑 `manual` IS THE DEFAULT SO THE SHIPPED BEHAVIOUR IS A LIST A SECOND
 * PERSON CAN READ. lee, 2026-10-31: *"manual as default with opt in for auto
 * through an easy flag"*, because *"I want it to be usable by other devs
 * too"*.
 *
 * Measured: `auto` let an un-allowlisted `rm` through with no denial at all,
 * so its gate is a classifier nobody can inspect. That is fine for an
 * operator who has lived with it and wrong as a default for someone who has
 * not.
 */
test('--auto is a shorthand, and an explicit --permission-mode still wins', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../../src/index.ts', import.meta.url), 'utf8');

  assert.match(src, /\.option\(\s*'--auto'/, 'there is no opt-in flag');
  assert.match(
    src,
    /permissionMode:\s*\n?\s*o\.permissionMode \?\?/,
    'the flag overrides an explicitly named mode',
  );
});

test('the help text says what --auto costs, not just what it does', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../../src/index.ts', import.meta.url), 'utf8');

  const help = src.slice(src.indexOf("'--auto'"), src.indexOf("'--auto'") + 400);

  assert.match(help, /allowlist/, 'the flag does not say what it replaces');
  assert.match(help, /not written down|cannot read|second person/, 'it does not state the cost');
});
