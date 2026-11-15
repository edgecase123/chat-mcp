import { manifestPathFor } from '../util/paths.js';
import {
  listCommands,
  readManifest,
  resolveArgv,
  type CommandManifest,
  type ListedCommand,
} from './commands.js';
import { commandLimits } from './command-limits.js';
import { checkedScriptPath } from './containment.js';
import { runScript, type ScriptResult, type ScriptRunner } from './run-script.js';

export {
  DEFAULT_MAX_BUFFER,
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_TIMEOUT_MS,
} from './command-limits.js';

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
  /** Per-handle cap on commands running at once. Below 1 is read as 1. */
  readonly maxConcurrent?: number;
  /** Test seam; see `run-script.ts`. */
  readonly run?: ScriptRunner;
}

/**
 * How many of each handle's commands are running, and who is waiting.
 *
 * 🛑 PER HANDLE, BY lee's RULING OF 2026-11-15. A timeout already bounds how
 * LONG one command runs (`DEFAULT_TIMEOUT_MS`); nothing bounded how many START,
 * so an agent could spawn host processes as fast as it issued tool calls.
 *
 * 🛑 KEYED BY HANDLE EVEN THOUGH A BARE COUNTER WOULD BE PER-HANDLE TODAY. One
 * process serves one handle: `startSupervisor` runs once per CLI invocation and
 * `openHostBus` once per supervisor. Keying it means the guarantee does not
 * rest on that, and nothing enforces it.
 *
 * Rejected: handing a released permit straight to the next waiter. It closes a
 * rare overtake by a synchronous arrival, and costs a non-obvious invariant.
 */
const running = new Map<string, number>();
const waiting = new Map<string, (() => void)[]>();

/**
 * 🛑 A `while`, NOT AN `if`. The woken waiter re-checks, so a release only has
 * to wake one of them. The check and the increment sit in one synchronous turn,
 * so two waiters cannot both pass the check.
 */
async function acquireSlot(handle: string, limit: number): Promise<void> {
  while ((running.get(handle) ?? 0) >= limit) {
    await new Promise<void>((resolve) => {
      const queue = waiting.get(handle) ?? [];

      queue.push(resolve);
      waiting.set(handle, queue);
    });
  }

  running.set(handle, (running.get(handle) ?? 0) + 1);
}

function releaseSlot(handle: string): void {
  const left = (running.get(handle) ?? 1) - 1;

  if (left <= 0) running.delete(handle);
  else running.set(handle, left);

  const queue = waiting.get(handle);
  const next = queue?.shift();

  if (queue !== undefined && queue.length === 0) waiting.delete(handle);

  next?.();
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
  // 🛑 RESOLVED ONCE, BEFORE ANY WAIT. `acquireSlot` takes a number, so a
  // command that parks keeps the limit it arrived with even if the file is
  // edited while it waits. The counter and the limit cannot disagree.
  let limits;

  try {
    limits = commandLimits();
  } catch (err) {
    // 🛑 A FIXED SENTENCE, NOT THE COLLABORATOR'S. Its message names
    // `limits.json` by absolute path, and that path is inside the directory the
    // container boundary exists to hide. `manifestFor` below is the same shape:
    // a fixed public sentence, the detail in `Refusal.detail`.
    throw new Refusal('the command limits on this host are not readable', err);
  }

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

  // 🛑 AFTER AUTHORIZATION, NOT BEFORE. A command refused for its name or its
  // script path must not wait behind work that is already running, and must not
  // hold a slot while being refused.
  //
  // A limit below 1 is read as 1. Honouring a 0 would wait forever, and a
  // caller that passes one wants throttling, never a deadlock.
  await acquireSlot(handle, Math.max(1, opts.maxConcurrent ?? limits.maxConcurrent));

  try {
    return await runScript(
      script,
      resolved.argv,
      {
        cwd: dir,
        timeout: opts.timeoutMs ?? limits.timeoutMs,
        maxBuffer: opts.maxBuffer ?? limits.maxBuffer,
      },
      opts.run,
    );
  } catch (err) {
    throw new Refusal(err instanceof Error ? err.message : 'the command failed to run', err);
  } finally {
    releaseSlot(handle);
  }
}
