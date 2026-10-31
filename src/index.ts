#!/usr/bin/env node
// node:sqlite is stable in v24 but still emits an ExperimentalWarning on
// v22.5–v23. Filter that one warning without hiding others — the shim uses
// stdio for MCP JSON-RPC on stdout and unrelated warnings would still land
// on stderr where they're useful.
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.name === 'ExperimentalWarning' && /SQLite/i.test(w.message)) return;
  console.error(w.stack ?? `${w.name}: ${w.message}`);
});

import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import { KNOWN_SUBCOMMANDS } from './util/subcommands.js';

function packageVersion(): string {
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');

    return (JSON.parse(raw) as { version?: string }).version ?? '0.0.0-unknown';
  } catch {
    return '0.0.0-unknown';
  }
}

async function runShimEntry(handle: string | undefined, force = false): Promise<void> {
  if (!handle) {
    console.error('Error: --handle <handle> is required in MCP shim mode');
    process.exit(1);
  }
  const { runShim } = await import('./shim/index.js');

  // 🛑 A refused claim must say WHY on stderr. An MCP client shows a stack
  // trace as "the server failed to start", which looks like a broken install
  // rather than another process holding the handle.
  try {
    await runShim({ handle, force });
  } catch (err) {
    const { HandleClaimedError } = await import('./storage/dao.js');
    if (err instanceof HandleClaimedError) {
      console.error(`chat-mcp: ${err.message}`);
      console.error('chat-mcp: pass --force-handle to claim it anyway.');
      process.exit(1);
    }
    throw err;
  }
}

// Backward-compat: `chat-mcp --handle X` (no subcommand) runs the MCP shim.
// This is the entry shape used by .mcp.json / claude mcp add, so we detect it
// before commander sees the args to avoid --handle colliding with subcommand
// options of the same name.

const firstArg = process.argv[2];
if (!firstArg || !KNOWN_SUBCOMMANDS.has(firstArg)) {
  const argv = process.argv.slice(2);
  const idx = argv.indexOf('--handle');
  const handle = idx >= 0 ? argv[idx + 1] : undefined;
  await runShimEntry(handle, argv.includes('--force-handle'));
} else {
  const program = new Command();

  program
    .name('chat-mcp')
    .description('Local unintrusive chat bus for AI coding agents over MCP')
    // 🛑 READ, NEVER HARDCODED. This said '0.3.0' while package.json said
    // '0.4.11', so `chat-mcp --version` had been lying for several releases —
    // which defeats the whole point of bumping the version to prove a new
    // build is the one running.
    //
    // `../package.json` resolves correctly from BOTH `src/index.ts` under tsx
    // and `dist/index.js` after a build, because both sit one level below the
    // package root.
    .version(packageVersion());

  program
    .command('cli')
    .description('Run the user CLI (terminal REPL joining the bus as a peer)')
    .option('--handle <handle>', 'peer handle for this session', 'user')
    .option('--experimental', 'use the full-screen Ink UI (autocomplete, palette, rooms browser, markdown)', false)
    .action(async (opts: { handle: string; experimental?: boolean }) => {
      if (opts.experimental) {
        const { runInkCli } = await import('./cli/ink/index.js');
        await runInkCli({ handle: opts.handle });
      } else {
        const { runCli } = await import('./cli/index.js');
        await runCli({ handle: opts.handle });
      }
    });

  program
    .command('web')
    .description('Launch the browser-based chat UI (localhost-only foreground server)')
    .option('--handle <handle>', 'peer handle for this session', 'user')
    .option('--port <port>', 'bind to a specific port (default: random free)', (v) => parseInt(v, 10))
    .option('--no-open', 'do not auto-open the default browser', false)
    .action(async (opts: { handle: string; port?: number; open?: boolean }) => {
      const { runWeb } = await import('./cli/web/server.js');
      await runWeb({ handle: opts.handle, port: opts.port, open: opts.open });
    });

  program
    .command('send <to> [body]')
    .description('Send a one-shot message to a peer (sender: --from or $CHAT_MCP_HANDLE)')
    .option('--from <handle>', 'sender handle (default: $CHAT_MCP_HANDLE)')
    .option('--stdin', 'read body from stdin (overrides positional body)', false)
    .option('--json', 'emit {message_id, sent_at} as JSON', false)
    .action(async (
      to: string,
      body: string | undefined,
      opts: { from?: string; stdin?: boolean; json?: boolean },
    ) => {
      const { runSend } = await import('./oneshot/send.js');
      await runSend({ to, body, from: opts.from, stdin: opts.stdin, json: opts.json });
    });

  program
    .command('inbox')
    .description('Read unread messages for a handle (default: $CHAT_MCP_HANDLE)')
    .option('--handle <handle>', 'recipient handle (default: $CHAT_MCP_HANDLE)')
    .option('--peek', 'do not mark messages read', false)
    .option('--json', 'emit an array of {id, from, body, sent_at} as JSON', false)
    .action(async (opts: { handle?: string; peek?: boolean; json?: boolean }) => {
      const { runInbox } = await import('./oneshot/inbox.js');
      await runInbox({ handle: opts.handle, peek: opts.peek, json: opts.json });
    });

  program
    .command('list')
    .description('List peers on the chat bus')
    .option('--all', 'include peers whose shim process is no longer alive', false)
    .option('--json', 'emit peer list as JSON', false)
    .action(async (opts: { all?: boolean; json?: boolean }) => {
      const { runList } = await import('./oneshot/list.js');
      await runList({ all: opts.all, json: opts.json });
    });

  program
    .command('members <room>')
    .description('List handles that are members of a room (includes offline members)')
    .option('--json', 'emit member list as JSON', false)
    .action(async (room: string, opts: { json?: boolean }) => {
      const { runMembers } = await import('./oneshot/members.js');
      await runMembers({ room, json: opts.json });
    });

  program
    .command('delete-room <room>')
    .description('Delete a room entirely (caller must be a member)')
    .option('--from <handle>', 'caller handle (default: $CHAT_MCP_HANDLE)')
    .option('--json', 'emit {room, deleted} as JSON', false)
    .action(async (room: string, opts: { from?: string; json?: boolean }) => {
      const { runDeleteRoom } = await import('./oneshot/delete_room.js');
      await runDeleteRoom({ room, from: opts.from, json: opts.json });
    });

  program
    .command('boot <room> <handle>')
    .description('Boot a participant from a room (caller must be a member; posts a system announcement)')
    .option('--from <handle>', 'caller handle (default: $CHAT_MCP_HANDLE)')
    .option('--json', 'emit {room, handle, removed} as JSON', false)
    .action(async (room: string, handle: string, opts: { from?: string; json?: boolean }) => {
      const { runBoot } = await import('./oneshot/boot.js');
      await runBoot({ room, handle, from: opts.from, json: opts.json });
    });

  program
    .command('install <framework>')
    .description('Install the wake adapter for a framework (e.g. claude-code, claude-code-context)')
    .requiredOption('--handle <handle>', 'agent handle this adapter arms')
    .option('--scope <scope>', 'adapter-specific scope (see list-adapters for defaults)')
    .option('--force', 'skip the .mcp.json handle-match check', false)
    .option('--cwd <path>', 'project directory for project/local-scope installs (default: process.cwd())')
    .option('--context-total <n>', "total context-window size for this agent's model (required by claude-code-context; e.g. 200000 for Sonnet, 1000000 for Opus 1M)", (v) => parseInt(v, 10))
    .action(async (framework: string, opts: { handle: string; scope?: string; force?: boolean; cwd?: string; contextTotal?: number }) => {
      const { runInstall } = await import('./adapters/index.js');
      const result = await runInstall(framework, {
        handle: opts.handle,
        scope: opts.scope,
        force: opts.force,
        cwd: opts.cwd,
        contextTotal: opts.contextTotal,
      });
      console.log(result.message);
    });

  program
    .command('uninstall <framework>')
    .description('Remove the wake adapter for a framework')
    .requiredOption('--handle <handle>', 'agent handle whose adapter to remove')
    .option('--scope <scope>', 'adapter-specific scope (must match install)')
    .option('--cwd <path>', 'project directory for project/local-scope uninstalls (default: process.cwd())')
    .action(async (framework: string, opts: { handle: string; scope?: string; cwd?: string }) => {
      const { runUninstall } = await import('./adapters/index.js');
      const result = await runUninstall(framework, {
        handle: opts.handle,
        scope: opts.scope,
        cwd: opts.cwd,
      });
      console.log(result.message);
    });

  program
    .command('list-adapters')
    .description('List available wake adapters and their supported scopes')
    .action(async () => {
      const { listAdapters } = await import('./adapters/index.js');
      for (const a of listAdapters()) {
        console.log(a.name);
        console.log(`  ${a.description}`);
        console.log(`  scopes: ${a.scopes.join(', ')} (default: ${a.defaultScope})`);
      }
    });

  program
    .command('aliases')
    .description('Print a source-able bash/zsh block with shell aliases')
    .action(async () => {
      const { SHELL_ALIASES } = await import('./shell/aliases.js');
      process.stdout.write(SHELL_ALIASES);
    });

  program
    .command('project <action> [handle] [dir]')
    .description('Register the project directory an agent works in: set | list | forget')
    .action(async (action: string, handle?: string, dir?: string) => {
      const { readProjects, registerProject, unregisterProject, projectsPath } = await import(
        './supervise/projects.js'
      );

      if (action === 'list') {
        const { agents } = readProjects();
        const names = Object.keys(agents);

        if (names.length === 0) {
          console.log(`no project directories registered (${projectsPath()})`);
          return;
        }

        for (const name of names) console.log(`${name}  ${(agents[name] ?? []).join('  ')}`);
        return;
      }

      if (action === 'forget') {
        if (!handle) {
          console.error('Error: chat-mcp project forget <handle>');
          process.exit(1);
        }
        unregisterProject(handle);
        console.log(`forgot ${handle}`);
        return;
      }

      if (action === 'set') {
        if (!handle || !dir) {
          console.error('Error: chat-mcp project set <handle> <dir>');
          process.exit(1);
        }
        try {
          console.log(`${handle}  ${registerProject(handle, dir).join('  ')}`);
        } catch (err) {
          console.error(`chat-mcp: ${err instanceof Error ? err.message : String(err)}`);
          process.exit(1);
        }
        return;
      }

      console.error(`Error: unknown action "${action}". Use set | list | forget.`);
      process.exit(1);
    });

  program
    .command('supervise <handle>')
    .description('Run a supervisor that owns the agent CLI and feeds it arriving messages (chat-mcp#33)')
    .option('--model <model>', 'model for the supervised child')
    .option('--binary <path>', 'path to the agent CLI', 'claude')
    .option('--driver <name>', 'which agent CLI to drive', 'claude')
    .option('--cwd <dir>', 'working directory for the child')
    .option('--resume <sessionId>', 'resume an existing session')
    .option(
      '--permission-mode <mode>',
      'permission mode for the child (default: manual, which enforces the allowlist)',
    )
    .option(
      '--auto',
      "let the CLI's own classifier decide instead of the allowlist — lower friction, " +
        'but the rule is not written down anywhere a second person can read',
      false,
    )
    .option('--permission-prompts <target>', 'who answers prompts: host | none', 'none')
    .option('--no-reply', 'do NOT let the child answer on the bus — makes this supervisor a doorbell')
    .option('--allowed-tools <tools>', "comma-separated tool allowlist for the child (default: lee's narrow list)")
    .action(async (handle: string, o: Record<string, string>) => {
      const { startSupervisor } = await import('./supervise/index.js');
      const sup = await startSupervisor({
        handle,
        model: o.model,
        binary: o.binary,
        driver: o.driver,
        cwd: o.cwd,
        resumeSessionId: o.resume,
        // 🛑 EXPLICIT --permission-mode STILL WINS. `--auto` is a shorthand,
        // not an override, so a mode named on the command line is never
        // silently replaced.
        permissionMode:
          o.permissionMode ?? ((o as unknown as { auto?: boolean }).auto ? 'auto' : undefined),
        permissionPrompts: o.permissionPrompts === 'host' ? 'host' : 'none',
        // commander turns --no-reply into reply:false and omits it otherwise.
        reply: (o as unknown as { reply?: boolean }).reply,
        allowedTools: typeof o.allowedTools === 'string' ? o.allowedTools.split(',') : undefined,
      });
      const shutdown = (): void => {
        void sup.stop().then(() => process.exit(0));
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    });

  program
    .command('report-context')
    .description(
      'Push a context-window gauge report for a handle (used by adapter hooks + shell scripts to reach the same DB path as the report_context MCP tool)',
    )
    .requiredOption('--handle <handle>', 'agent handle whose gauge to update')
    .requiredOption('--used <n>', 'tokens currently consumed', (v) => parseInt(v, 10))
    .requiredOption('--total <n>', "total context-window size for this agent's model", (v) => parseInt(v, 10))
    .option('--json', 'emit the transition payload as JSON', false)
    .action(async (opts: { handle: string; used: number; total: number; json?: boolean }) => {
      const { runReportContext } = await import('./oneshot/report_context.js');
      await runReportContext(opts);
    });

  await program.parseAsync(process.argv).catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
