import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { askBroker, brokerAddress, NO_BROKER } from '../broker-client.js';

/**
 * #133 slice 4 — the two tools a containerized agent uses to run its project's
 * own commands on the host.
 *
 * 🛑 NEITHER TOOL DECIDES ANYTHING. The name and the params go to the broker
 * untouched, because the broker holds the manifest and the manifest is the only
 * thing allowed to say which script a name means.
 *
 * 🛑 BOTH TOOLS ARE REGISTERED ONLY WHEN A BROKER EXISTS. An ordinary session
 * has neither env var, and advertising two tools that can only refuse reads as
 * a capability the agent does not have.
 */

const text = (payload: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
});

/**
 * One ask, as the payload a tool returns.
 *
 * 🛑 `ok` SEPARATES A REFUSAL FROM A RESULT, NOT SUCCESS FROM FAILURE. A
 * command that ran and exited 3 is `ok: true` with `exitCode: 3`. Collapsing
 * the two would make a failing gate indistinguishable from a broker that never
 * answered, and the caller's next move differs for each.
 */
export async function askForTool(
  op: string,
  body: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Record<string, unknown>> {
  const address = brokerAddress(env);

  // Not an error. Every session outside a supervised container lands here.
  if (address === null) return { ok: false, error: NO_BROKER };

  try {
    return { ok: true, ...(await askBroker(op, body, { address })) };
  } catch (err) {
    // The client's own four sentences, or the broker's verbatim refusal. Both
    // are written for this caller; neither carries a host path.
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function installRunCommand(server: McpServer, env: NodeJS.ProcessEnv = process.env): void {
  if (brokerAddress(env) === null) return;

  server.registerTool(
    'list_commands',
    {
      title: "Which of this project's commands can I run?",
      description:
        'Every command this agent may run on the host, with the parameters each one takes. The list comes from a manifest the agent cannot edit, so a name missing from it cannot be run however it is spelled. Call this before run_command rather than guessing a name.',
      inputSchema: {},
    },
    async () => text(await askForTool('list-commands', {}, env)),
  );

  server.registerTool(
    'run_command',
    {
      title: "Run one of this project's commands on the host",
      description:
        'Run a command from list_commands in the project directory on the host, and return its exit code, stdout and stderr. A non-zero exit code is a RESULT: it comes back with ok true, because the command ran. ok false means the command did not run at all, and the error says why.',
      inputSchema: {
        name: z.string().min(1).describe('The command name, exactly as list_commands reports it.'),
        params: z
          .record(z.string(), z.string())
          .optional()
          .describe('The declared parameters for that command, by name. Omit when it takes none.'),
      },
    },
    async ({ name, params }) => text(await askForTool('run-command', { name, params: params ?? {} }, env)),
  );
}
