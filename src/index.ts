#!/usr/bin/env node
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
const KNOWN_SUBCOMMANDS = new Set(['cli', 'install', 'uninstall', 'list-adapters', 'aliases', 'help', '--help', '-h', '--version', '-V']);
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
    .version('0.0.1');

  program
    .command('cli')
    .description('Run the user CLI (terminal REPL joining the bus as a peer)')
    .option('--handle <handle>', 'peer handle for this session', 'user')
    .action(async (opts: { handle: string }) => {
      const { runCli } = await import('./cli/index.js');
      await runCli({ handle: opts.handle });
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
