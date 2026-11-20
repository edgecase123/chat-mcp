import { manifestPathFor } from "../util/paths.js";
import {
  listCommands,
  readManifest,
  resolveArgv,
  type CommandManifest,
  type ListedCommand,
} from "./commands.js";
import { commandLimits } from "./command-limits.js";
import type { SandboxMode } from "./vendor.js";
import { checkedScriptPath } from "./containment.js";
import {
  runScript,
  type ScriptResult,
  type ScriptRunner,
} from "./run-script.js";

export {
  DEFAULT_MAX_BUFFER,
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_TIMEOUT_MS,
} from "./command-limits.js";

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
    this.name = "Refusal";
    this.detail =
      cause instanceof Error ? cause.message : String(cause ?? publicMessage);
  }
}

export interface RunCommandOptions {
  /**
   * 🛑 THE SUPERVISOR'S OWN RESOLVED MODE, NEVER ANYTHING AN AGENT SUPPLIES.
   * Both transports that reach this service are constructed inside the
   * supervisor, which already holds `selection.mode`.
   *
   * ⚠️ REQUIRED, AND `opts` IS NO LONGER DEFAULTED, so a transport that omits
   * it is a compile error rather than a host execution. An optional field here
   * would fail OPEN, which is the wrong direction for the only guard between a
   * sandboxed agent and `execFile`.
   */
  readonly sandbox: SandboxMode;
  readonly timeoutMs?: number;
  readonly maxBuffer?: number;
  /** Per-handle cap on commands running at once. Below 1 is read as 1. */
  readonly maxConcurrent?: number;
  /** Test seam; see `run-script.ts`. */
  readonly run?: ScriptRunner;
}

/**
 * How many of each handle's commands are running.
 *
 * 🛑 PER HANDLE, BY lee's RULING OF 2026-11-15. A timeout already bounds how
 * LONG one command runs (`DEFAULT_TIMEOUT_MS`); nothing bounded how many START,
 * so an agent could spawn host processes as fast as it issued tool calls.
 *
 * 🛑 KEYED BY HANDLE EVEN THOUGH A BARE COUNTER WOULD BE PER-HANDLE TODAY. One
 * process serves one handle: `startSupervisor` runs once per CLI invocation and
 * `openHostBus` once per supervisor. Keying it means the guarantee does not
 * rest on that, and nothing enforces it.
 */
const running = new Map<string, number>();

/**
 * Takes one of `handle`'s slots, or refuses.
 *
 * 🛑 REFUSES, NEVER WAITS, BY lee's RULING OF 2026-11-15. A parked call is
 * invisible latency that the caller cannot tell apart from a hung command, so
 * it leaves no correct reaction available.
 *
 * 🛑 SYNCHRONOUS, WHICH IS WHAT MAKES THE CHECK AND THE INCREMENT ATOMIC. An
 * `await` between the two would let two arrivals both pass the check.
 *
 * Rejected: a short wait before refusing. It reintroduces the latency the
 * ruling removed, for a burst the caller can retry itself.
 */
function takeSlot(handle: string, limit: number): void {
  if ((running.get(handle) ?? 0) >= limit) {
    throw new Refusal("the command runner is busy; retry");
  }

  running.set(handle, (running.get(handle) ?? 0) + 1);
}

function releaseSlot(handle: string): void {
  const left = (running.get(handle) ?? 1) - 1;

  if (left <= 0) running.delete(handle);
  else running.set(handle, left);
}

/**
 * 🛑 THE MANIFEST IS THE ONLY SOURCE OF THE DIRECTORY. `projects.json` sits in
 * the state directory, so an agent that could rewrite it would otherwise pick
 * the tree its own commands run in.
 *
 * One manifest per handle gives one directory, so no candidate can conflict.
 * Pinned by `rewriting the registration does not move where a command runs`.
 */
export function manifestFor(handle: string): {
  dir: string;
  manifest: CommandManifest;
} {
  let manifest: CommandManifest;

  try {
    manifest = readManifest(manifestPathFor(handle));
  } catch (err) {
    throw new Refusal("this agent has no usable command manifest", err);
  }

  return { dir: manifest.projectDir, manifest };
}

/**
 * What `listCommandsFor` needs, which is the mode and nothing else.
 *
 * 🛑 REQUIRED, AND THE PARAMETER IS NOT DEFAULTED, for `RunCommandOptions`'
 * reason: a transport that omits it must be a compile error rather than an
 * ungated list. Both transports that reach this service already hold the mode.
 */
export type ListCommandsOptions = Pick<RunCommandOptions, "sandbox">;

/**
 * 🛑 THE ONE PLACE THAT SAYS COMMANDS DO NOT RUN IN A CONTAINER. Two callers
 * need this refusal and a second copy of the sentence is how the two drift —
 * which is the defect four `messages` writers had just been merged for.
 *
 * lee, 2026-11-15: "anything the agent can write is NOT trusted to run outside
 * of the container." A containerized agent has its project directory
 * bind-mounted writable, so it chooses the bytes the operator would run.
 */
function refuseInContainer(opts: ListCommandsOptions): void {
  if (opts.sandbox !== "docker") return;

  throw new Refusal(
    "commands do not run for an agent in a container, because this agent " +
      "can write the files they are made of",
  );
}

/**
 * The commands `handle`'s manifest declares, or a refusal.
 *
 * 🛑 REFUSES A CONTAINERIZED CALLER RATHER THAN LISTING. The tool's own
 * description called this list "every command this agent may run", and for a
 * containerized agent every one of them is then refused by `runCommandFor`. An
 * agent acting on that list retries, concludes the bus is broken, and an
 * operator reads the confusion as a transport fault. #264.
 *
 * ⚠️ NOT AN EMPTY LIST. That is indistinguishable from having no manifest, so
 * the agent learns nothing it can act on.
 */
export function listCommandsFor(
  handle: string,
  opts: ListCommandsOptions,
): { commands: ListedCommand[] } {
  // Before the manifest is read, so a refused call touches no file and names no
  // host path — the order `runCommandFor` uses, for the same reason.
  refuseInContainer(opts);

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
  opts: RunCommandOptions,
): Promise<ScriptResult> {
  // 🛑 FIRST, BEFORE THE MANIFEST AND BEFORE ANY SLOT. `runScript` reaches the
  // project directory with `execFile`, on the host, so a refused call must cost
  // nothing and take no concurrency slot.
  refuseInContainer(opts);

  // 🛑 READ PER CALL, AND NOTHING AWAITS BETWEEN THIS READ AND THE SLOT TAKE.
  // So a refusal is always measured against the file as it stands now, and a
  // raised cap binds on the very next command rather than the next restart.
  let limits;

  try {
    limits = commandLimits();
  } catch (err) {
    // 🛑 A FIXED SENTENCE, NOT THE COLLABORATOR'S. Its message names
    // `limits.json` by absolute path, and that path is inside the directory the
    // container boundary exists to hide. `manifestFor` below is the same shape:
    // a fixed public sentence, the detail in `Refusal.detail`.
    throw new Refusal("the command limits on this host are not readable", err);
  }

  const { dir, manifest } = manifestFor(handle);

  // The caller named this command and supplied these values, so this message
  // discloses only what it already knows.
  let resolved;

  try {
    resolved = resolveArgv(manifest, name, params as Record<string, string>);
  } catch (err) {
    throw new Refusal(
      err instanceof Error ? err.message : "the command was refused",
      err,
    );
  }

  // 🛑 THE ONLY WAY TO A PATH. `resolved.script` is an object, so reaching the
  // runner without this call is a compile error rather than a missing symlink
  // check.
  let script: string;

  try {
    script = checkedScriptPath(dir, resolved.script);
  } catch (err) {
    throw new Refusal(
      "the command script is not inside the project directory",
      err,
    );
  }

  // 🛑 AFTER AUTHORIZATION, NOT BEFORE. A command refused for its name or its
  // script path must not be refused as busy instead, which would tell the
  // caller to retry something that can never succeed.
  //
  // A limit below 1 is read as 1. Honouring a 0 would refuse every command, and
  // a caller that passes one wants throttling, never a closed door.
  takeSlot(handle, Math.max(1, opts.maxConcurrent ?? limits.maxConcurrent));

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
    throw new Refusal(
      err instanceof Error ? err.message : "the command failed to run",
      err,
    );
  } finally {
    releaseSlot(handle);
  }
}
