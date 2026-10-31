/**
 * Every subcommand `chat-mcp` answers to.
 *
 * 🛑 THIS LIST IS LOAD-BEARING AND ITS FAILURE IS SILENT. `chat-mcp --handle X`
 * with no subcommand runs the MCP shim, which is the shape `.mcp.json` uses.
 * So the entry point checks the first argument against this set BEFORE
 * commander sees it. A verb registered with commander but missing from here
 * does not error — it falls through to shim mode and the process tries to
 * start an MCP server, reporting a missing `--handle` instead of an unknown
 * command.
 *
 * Extracted from `src/index.ts` so it can be asserted without importing that
 * module, which runs the CLI on import.
 */
export const KNOWN_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'cli',
  'web',
  'project',
  'send',
  'inbox',
  'list',
  'members',
  'delete-room',
  'boot',
  'install',
  'uninstall',
  'list-adapters',
  'aliases',
  'report-context',
  'supervise',
  'help',
  '--help',
  '-h',
  '--version',
  '-V',
]);
