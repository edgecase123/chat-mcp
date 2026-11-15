import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ShimContext } from "../index.js";
import type { ListedCommand } from "../../supervise/commands.js";
import {
  Refusal,
  listCommandsFor,
  runCommandFor,
  type RunCommandOptions,
} from "../../supervise/run-command-service.js";
import type { ScriptResult } from "../../supervise/run-script.js";

/**
 * #133 slice 4 — the two tools an agent uses to run its project's own commands.
 *
 * 🛑 NEITHER TOOL DECIDES ANYTHING. The name and the params reach
 * `run-command-service` untouched, because the manifest is the only thing
 * allowed to say which script a name means and which directory it runs in.
 *
 * 🛑 BOTH TOOLS ARE ALWAYS REGISTERED, AND THE MISSING-MANIFEST REFUSAL IS THE
 * CAPABILITY CHECK. Nothing in `src/` writes a manifest, so a file dropped into
 * `manifestDir()` mid-session is the ordinary case rather than an edge one.
 * Gating registration on the manifest would mean an operator writes one, sees
 * no tool, and restarts the agent to get it.
 */

const text = (payload: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(payload) }],
});

/** What either tool resolves to when nothing refused it. Mirrors the broker's own dispatch. */
type Answer = { commands: ListedCommand[] } | ScriptResult;

/** Said to the caller when the failure is not a `Refusal` written for them. */
export const COULD_NOT_RUN = "the command could not be run";

/**
 * One call, as the payload a tool returns.
 *
 * 🛑 `ok` SEPARATES A REFUSAL FROM A RESULT, NOT SUCCESS FROM FAILURE. A
 * command that ran and exited 3 is `ok: true` with `exitCode: 3`. Collapsing
 * the two would make a failing gate indistinguishable from a command that never
 * started, and the caller's next move differs for each.
 *
 * 🛑 ONLY A `Refusal`'s MESSAGE CROSSES TO THE CALLER. Its `detail` names
 * absolute host directories and goes to the operator's log instead.
 */
export async function answerFor(
  handle: string,
  work: () => Promise<Answer> | Answer,
): Promise<Record<string, unknown>> {
  try {
    return { ...(await work()), ok: true };
  } catch (err) {
    if (err instanceof Refusal) {
      console.error(
        `run_command refused a request from "${handle}": ${err.detail}`,
      );

      return { ok: false, error: err.message };
    }

    console.error(
      `run_command failed a request from "${handle}": ${String(err)}`,
    );

    return { ok: false, error: COULD_NOT_RUN };
  }
}

export function installRunCommand(
  server: McpServer,
  ctx: ShimContext,
  opts: RunCommandOptions = {},
): void {
  server.registerTool(
    "list_commands",
    {
      title: "Which of this project's commands can I run?",
      description:
        "Every command this agent may run, with the parameters each one takes. The list comes from a manifest the agent cannot edit, so a name missing from it cannot be run however it is spelled. Call this before run_command rather than guessing a name. An agent with no manifest gets ok false and an error saying so.",
      inputSchema: {},
    },
    async () =>
      text(await answerFor(ctx.handle, () => listCommandsFor(ctx.handle))),
  );

  server.registerTool(
    "run_command",
    {
      title: "Run one of this project's commands",
      description:
        "Run a command from list_commands in the project directory, and return its exit code, stdout and stderr. A non-zero exit code is a RESULT: it comes back with ok true, because the command ran. ok false means the command did not run at all, and the error says why.",
      inputSchema: {
        name: z
          .string()
          .min(1)
          .describe("The command name, exactly as list_commands reports it."),
        params: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            "The declared parameters for that command, by name. Omit when it takes none.",
          ),
      },
    },
    async ({ name, params }) =>
      text(
        await answerFor(ctx.handle, () =>
          runCommandFor(ctx.handle, name, params ?? {}, opts),
        ),
      ),
  );
}
