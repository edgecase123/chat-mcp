import { manifestPathFor } from '../util/paths.js';
import {
  listCommands,
  readManifest,
  resolveArgv,
  type CommandManifest,
  type ListedCommand,
} from './commands.js';
import { checkedScriptPath } from './containment.js';
import { runScript, type ScriptResult, type ScriptRunner } from './run-script.js';

export const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
export const DEFAULT_MAX_BUFFER = 8 * 1024 * 1024;

/**
 * A refusal with two faces: what the caller is told, and what the operator can
 * read in the host's log.
 *
 * 🛑 THE CALLER NEVER SEES A HOST PATH. A collaborator's message names absolute
 * directories and says whether a path exists and what it resolved to — and the
 * caller writes the manifest, so forwarding that would answer arbitrary
 * existence and realpath questions about the whole host.
 */
export class Refusal extends Error {
  readonly detail: string;

  constructor(publicMessage: string, cause?: unknown) {
    super(publicMessage);
    this.name = 'Refusal';
    this.detail = cause instanceof Error ? cause.message : String(cause ?? publicMessage);
  }
}

export interface RunCommandOptions {
  readonly timeoutMs?: number;
  readonly maxBuffer?: number;
  /** Test seam; see `run-script.ts`. */
  readonly run?: ScriptRunner;
}

/**
 * 🛑 THE MANIFEST IS THE ONLY SOURCE OF THE DIRECTORY. `projects.json` sits in
 * the state directory, so an agent that could rewrite it would otherwise pick
 * the tree its own commands run in.
 *
 * One manifest per handle gives one directory, so no candidate can conflict.
 * Pinned by `rewriting the registration does not move where a command runs`.
 */
export function manifestFor(handle: string): { dir: string; manifest: CommandManifest } {
  let manifest: CommandManifest;

  try {
    manifest = readManifest(manifestPathFor(handle));
  } catch (err) {
    throw new Refusal('this agent has no usable command manifest', err);
  }

  return { dir: manifest.projectDir, manifest };
}

export function listCommandsFor(handle: string): { commands: ListedCommand[] } {
  return { commands: listCommands(manifestFor(handle).manifest) };
}

/**
 * Authorize one named command against `handle`'s manifest, then run it.
 *
 * 🛑 NO CALLER DECIDES ANYTHING. The name and the params arrive untouched,
 * because the manifest is the only thing allowed to say which script a name
 * means and which directory it runs in.
 */
export async function runCommandFor(
  handle: string,
  name: string,
  params: Readonly<Record<string, string>>,
  opts: RunCommandOptions = {},
): Promise<ScriptResult> {
  const { dir, manifest } = manifestFor(handle);

  // The caller named this command and supplied these values, so this message
  // discloses only what it already knows.
  let resolved;

  try {
    resolved = resolveArgv(manifest, name, params as Record<string, string>);
  } catch (err) {
    throw new Refusal(err instanceof Error ? err.message : 'the command was refused', err);
  }

  // 🛑 THE ONLY WAY TO A PATH. `resolved.script` is an object, so reaching the
  // runner without this call is a compile error rather than a missing symlink
  // check.
  let script: string;

  try {
    script = checkedScriptPath(dir, resolved.script);
  } catch (err) {
    throw new Refusal('the command script is not inside the project directory', err);
  }

  try {
    return await runScript(
      script,
      resolved.argv,
      {
        cwd: dir,
        timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: opts.maxBuffer ?? DEFAULT_MAX_BUFFER,
      },
      opts.run,
    );
  } catch (err) {
    throw new Refusal(err instanceof Error ? err.message : 'the command failed to run', err);
  }
}
