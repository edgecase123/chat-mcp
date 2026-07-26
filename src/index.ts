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

import { Command } from 'commander';

async function runShimEntry(handle: string | undefined): Promise<void> {
  if (!handle) {
    console.error('Error: --handle <handle> is required in MCP shim mode');
    process.exit(1);
  }
  const { runShim } = await import('./shim/index.js');
  await runShim({ handle });
}

// Backward-compat: `chat-mcp --handle X` (no subcommand) runs the MCP shim.
// This is the entry shape used by .mcp.json / claude mcp add, so we detect it
// before commander sees the args to avoid --handle colliding with subcommand
// options of the same name.
const KNOWN_SUBCOMMANDS = new Set(['cli', 'send', 'inbox', 'list', 'members', 'delete-room', 'boot', 'install', 'uninstall', 'list-adapters', 'aliases', 'help', '--help', '-h', '--version', '-V']);
const firstArg = process.argv[2];
if (!firstArg || !KNOWN_SUBCOMMANDS.has(firstArg)) {
  const argv = process.argv.slice(2);
  const idx = argv.indexOf('--handle');
  const handle = idx >= 0 ? argv[idx + 1] : undefined;
  await runShimEntry(handle);
} else {
  const program = new Command();

  program
    .name('chat-mcp')
    .description('Local unintrusive chat bus for AI coding agents over MCP')
    .version('0.3.0');

  program
    .command('cli')
    .description('Run the user CLI (terminal REPL joining the bus as a peer)')
    .option('--handle <handle>', 'peer handle for this session', 'user')
    .action(async (opts: { handle: string }) => {
      const { runCli } = await import('./cli/index.js');
      await runCli({ handle: opts.handle });
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
    .description('Install the wake adapter for a framework (e.g. claude-code)')
    .requiredOption('--handle <handle>', 'agent handle this adapter arms')
    .option('--scope <scope>', 'adapter-specific scope (see list-adapters for defaults)')
    .option('--force', 'skip the .mcp.json handle-match check', false)
    .action(async (framework: string, opts: { handle: string; scope?: string; force?: boolean }) => {
      const { runInstall } = await import('./adapters/index.js');
      const result = await runInstall(framework, {
        handle: opts.handle,
        scope: opts.scope,
        force: opts.force,
      });
      console.log(result.message);
    });

  program
    .command('uninstall <framework>')
    .description('Remove the wake adapter for a framework')
    .requiredOption('--handle <handle>', 'agent handle whose adapter to remove')
    .option('--scope <scope>', 'adapter-specific scope (must match install)')
    .action(async (framework: string, opts: { handle: string; scope?: string }) => {
      const { runUninstall } = await import('./adapters/index.js');
      const result = await runUninstall(framework, { handle: opts.handle, scope: opts.scope });
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

  await program.parseAsync(process.argv).catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
