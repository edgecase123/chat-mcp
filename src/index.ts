#!/usr/bin/env node
import { Command } from 'commander';

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
  .option('--handle <handle>', 'peer handle for this MCP shim')
  .action(async (opts: { handle?: string }) => {
    if (!opts.handle) {
      console.error('Error: --handle <handle> is required in MCP shim mode');
      process.exit(1);
    }
    const { runShim } = await import('./shim/index.js');
    await runShim({ handle: opts.handle });
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
