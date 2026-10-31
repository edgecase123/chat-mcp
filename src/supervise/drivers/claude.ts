import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AgentChild, SpawnOptions } from '../child.js';
import { createLineParser } from '../child.js';
import { type RateLimitSnapshot } from '../rate-limit.js';
import { parseClaudeRateLimit } from './claude-events.js';
import { denialFromClaude } from './claude-events.js';
import type { Denial } from '../denial.js';
import { ensureMcpConfigDir, mcpConfigPathFor } from '../../util/paths.js';

/**
 * The Claude Code driver: the ONLY file that knows this CLI's flags and event
 * shapes.
 *
 * 🛑 A SECOND DRIVER IS A SIBLING OF THIS FILE AND CHANGES NOTHING ELSE. The
 * queue, the gate, the socket and the held-message release all speak the
 * semantic `AgentChild` callbacks.
 */
/**
 * Build the argv for a supervised `claude` child.
 *
 * Exported separately from the spawn so the flag set is assertable without
 * launching a process or spending anything.
 *
 * ⚠️ `--verbose` is NOT optional. Measured on 2026-10-16: without it the
 * process exits 1 with
 *   `When using --print, --output-format=stream-json requires --verbose`
 * and that requirement appears in no `--help` text for either flag.
 */
export function claudeArgs(opts: SpawnOptions = {}): string[] {
  const args = [
    '-p',
    '--verbose',
    '--output-format',
    'stream-json',
    '--input-format',
    'stream-json',
    '--permission-mode',
    // 🛑 `plan` DENIES every tool, measured on chat-mcp#33 — a child in plan
    // mode wakes, understands it is on the bus, tries to answer and is
    // refused. So a working child needs a mode that permits an allowlisted
    // tool, and `acceptEdits` is the one proven to.
    //
    // ⚠️ AN EARLIER VERSION OF THIS COMMENT SAID acceptEdits "widens nothing,
    // because `--tools ''` means there is no Edit tool to accept". THAT
    // PREMISE WAS DELETED when Write and Edit became available, and the
    // comment outlived it. What actually contains the mode now is that NO
    // bare `Write` or `Edit` is allowlisted — only `Edit(<glob>)` scopes.
    // Found by claude1 reviewing PR 34.
    //
    // An explicit --permission-mode always wins over both defaults.
    opts.permissionMode ?? (opts.grant ? 'acceptEdits' : 'plan'),
    '--permission-prompts',
    opts.permissionPrompts ?? 'none',
  ];

  if (opts.model) args.push('--model', opts.model);
  if (opts.resumeSessionId) args.push('--resume', opts.resumeSessionId);

  // 🛑 ALL FOUR OR NONE. `--mcp-config` ADDS to whatever the cwd already
  // configures, so without `--strict-mcp-config` the child also loads the
  // project's `.mcp.json` and registers under the handle hardcoded there —
  // the handle a live session is already using. `--tools ''` removes every
  // built-in, which is what makes the allowlist a least-privilege grant
  // rather than a wider permission mode.
  if (opts.grant) {
    args.push(
      '--mcp-config',
      opts.grant.configPath,
      '--strict-mcp-config',
      '--tools',
      // 🛑 SPACE-SEPARATED, because `--tools <tools...>` is variadic.
      //
      // ⚠️ AN EMPTY LIST WOULD EMIT A VALUELESS FLAG and the next argument
      // would be swallowed as its value. Fail CLOSED with an explicit empty
      // string instead, which disables every built-in — the reply-only
      // behaviour. Raised by claude1 reviewing PR 34.
      ...(opts.grant.available.length > 0 ? opts.grant.available : ['']),
      '--allowedTools',
      opts.grant.allowed.join(','),
    );

    // 🛑 WHERE the child may write, which the allowlist does NOT control.
    // Measured 2026-10-31: the same `Edit(<glob>)` allowlist entry is denied
    // under one cwd and permitted under another, because file writes are
    // confined to the working directory. This flag is the only thing that
    // widens it. Claude Code's spelling; another driver uses its own.
    if (opts.grant.extraDirs.length > 0) {
      args.push('--add-dir', ...opts.grant.extraDirs);
    }
  }

  return args;
}

/**
 * How to launch this build of chat-mcp as the child's MCP server.
 *
 * 🛑 RESOLVED MODULE-RELATIVE, NEVER FROM `process.argv[1]`. argv[1] was used
 * here to mean "the chat-mcp entry point". It means "whatever script is
 * running right now". Under the installed bin those coincide; under a script
 * or a test they do not, so a child got
 * `node scripts/supervise-live.mjs --handle ...` and had NO chat tool at all.
 * It woke, ran its turn, and could not answer. Found by the live harness —
 * every unit test here asserted the handle and none asserted the command.
 *
 * `package.json` ships only `dist`, so from `dist/supervise/child.js` the
 * sibling `../index.js` is the installed `bin`. Running from source there is
 * no `../index.js`, and the TypeScript entry needs a loader or the child exits
 * immediately — which looks exactly like the bug above.
 */
function resolveChatMcpEntry(): { command: string; args: string[] } {
  // Installed layout: dist/supervise/child.js next to dist/index.js.
  const built = fileURLToPath(new URL('../index.js', import.meta.url));
  if (existsSync(built)) return { command: process.execPath, args: [built] };

  // Source layout with a build present — preferred, because it needs no loader
  // and therefore nothing to resolve from the child's cwd.
  const builtFromSource = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
  if (existsSync(builtFromSource)) return { command: process.execPath, args: [builtFromSource] };

  // Source layout with no build. The loader has to be an ABSOLUTE path.
  const source = fileURLToPath(new URL('../index.ts', import.meta.url));
  if (existsSync(source)) {
    return { command: process.execPath, args: ['--import', resolveLoader(), source] };
  }

  throw new Error(
    `cannot locate the chat-mcp entry point next to ${import.meta.url}; ` +
      'pass an explicit entry to writeClaudeMcpConfig',
  );
}

/**
 * The tsx loader as an ABSOLUTE path.
 *
 * 🛑 `--import tsx` IS A BARE SPECIFIER AND THE CHILD RESOLVES IT FROM ITS OWN
 * CWD. The supervised child runs in whatever directory the operator chose, and
 * the live harness uses an empty temp dir — which has no `node_modules` above
 * it, so the chat server died with `ERR_MODULE_NOT_FOUND` the instant it
 * started. The agent then had no chat tool and WROTE OUT the call it could not
 * make, which reads like a model failure rather than a missing dependency.
 *
 * ⚠️ SECOND INSTANCE OF ONE MISTAKE. The script path was already absolute; the
 * loader name was not. Any part of this command line that is resolved rather
 * than stated is resolved against the CHILD's cwd, not ours.
 */
function resolveLoader(): string {
  return fileURLToPath(import.meta.resolve('tsx'));
}

/**
 * Write the child's own MCP config and return its path.
 *
 * 🛑 The child must reach the bus under a handle of its OWN. `inbox` marks
 * messages read, so a child sharing the supervisor's handle silently consumes
 * the deliveries meant for it. See chat-mcp#35.
 *
 * The server command is the binary this supervisor is itself running, not a
 * fresh `npx` fetch, so the child cannot end up on a different build of the
 * bus than the process delivering to it.
 */
export function writeClaudeMcpConfig(handle: string, entry?: string): string {
  ensureMcpConfigDir();

  const launch = entry ? { command: process.execPath, args: [entry] } : resolveChatMcpEntry();
  const path = mcpConfigPathFor(handle);
  const config = {
    mcpServers: {
      chat: {
        command: launch.command,
        args: [...launch.args, '--handle', handle],
      },
    },
  };

  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

  return path;
}

/**
 * Map ONE parsed Claude Code event onto the semantic callbacks.
 *
 * 🛑 EXPORTED SO IT CAN BE TESTED WITHOUT SPAWNING. A negative control that
 * deleted this mapping from inside `spawnClaude` broke NOTHING, because every
 * supervisor test drives a fake child that signals turn-end directly. The
 * fake bypassed the only Claude-specific logic left in the system.
 *
 * ⚠️ A second driver writes its own version of this function and nothing else
 * changes. That is the seam.
 */
export function routeClaudeEvent(
  event: Record<string, unknown>,
  on: {
    turnEnd(): void;
    usage(snapshot: RateLimitSnapshot): void;
    denial?(denial: Denial): void;
    session?(id: string): void;
  },
): void {
  const usage = parseClaudeRateLimit(event);

  if (usage) on.usage(usage);

  // 🛑 THE PRODUCER FOR THE APPROVAL PATH. Without this the detector was
  // imported and never called, `insertApproval` had no caller, and the whole
  // relay started one step after the break — which is exactly how the live
  // test passed while the feature did not exist. Found by claude1.
  const denial = denialFromClaude(event);
  if (denial && on.denial) on.denial(denial);

  // The session id arrives on the `system` init event and is what makes a
  // grant resumable instead of a restart.
  const id = event.session_id;
  if (typeof id === 'string' && on.session) on.session(id);

  // `result` is Claude Code's terminal event. An `assistant` event with no
  // following `result` is a turn still in flight.
  if (event.type === 'result') on.turnEnd();
}

export function spawnClaude(opts: SpawnOptions = {}): AgentChild {
  const child: ChildProcessWithoutNullStreams = spawn(
    opts.binary ?? 'claude',
    claudeArgs(opts),
    { cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'] },
  ) as ChildProcessWithoutNullStreams;

  const eventCbs: ((e: Record<string, unknown>) => void)[] = [];
  const turnEndCbs: (() => void)[] = [];
  const usageCbs: ((s: RateLimitSnapshot) => void)[] = [];
  const denialCbs: ((d: Denial) => void)[] = [];
  const sessionCbs: ((id: string) => void)[] = [];
  let lastSession: string | null = null;

  const feed = createLineParser((parsed) => {
    for (const cb of eventCbs) cb(parsed);

    routeClaudeEvent(parsed, {
      turnEnd: () => {
        for (const cb of turnEndCbs) cb();
      },
      usage: (snapshot) => {
        for (const cb of usageCbs) cb(snapshot);
      },
      denial: (d) => {
        for (const cb of denialCbs) cb(d);
      },
      session: (id) => {
        // Only the FIRST sighting matters; every later event repeats it.
        if (lastSession === id) return;
        lastSession = id;
        for (const cb of sessionCbs) cb(id);
      },
    });
  });

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', feed);

  return {
    // Claude Code emits `rate_limit_event` unprompted, so this driver meters.
    reportsUsage: true,
    send(text: string): void {
      // The documented streaming-input shape: one JSON user message per line.
      const message = {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text }] },
      };
      child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    onTurnEnd(cb): void {
      turnEndCbs.push(cb);
    },
    onUsage(cb): void {
      usageCbs.push(cb);
    },
    onDenial(cb): void {
      denialCbs.push(cb);
    },
    onSession(cb): void {
      sessionCbs.push(cb);
      // A late subscriber must not miss an id that already arrived.
      if (lastSession) cb(lastSession);
    },
    onEvent(cb): void {
      eventCbs.push(cb);
    },
    onExit(cb): void {
      child.on('exit', (code, signal) => cb(code, signal));
    },
    kill(): void {
      child.kill();
    },
  };
}
