import {
  spawn as spawnChild,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import type { Readable, Writable } from "node:stream";
import type { VendorSpawn } from "../supervise/vendor.js";
import { runTurnRelay } from "../supervise/drivers/turn-relay.js";

/**
 * The container's command for a per-turn vendor: parse argv, then relay.
 *
 * 🛑 IT LIVES OUTSIDE `supervise/` BECAUSE IT RESOLVES A VENDOR BY NAME.
 * `spawn-contract.test.ts` holds `supervise/` to a one-way dependency on
 * `adapters/`, and the relay needs the registry that maps `cursor` to its
 * router. The lookup is a parameter here, so this module imports neither.
 *
 * 🛑 NOTHING RUNS AT IMPORT, AND THAT IS #359 NOT REPEATED. `src/index.ts`
 * starts its CLI as a side effect of being imported, so no test can reach its
 * start sequence. `bin.ts` beside this file is the executable; this is the
 * function.
 */

/**
 * The relay's exit code for an argv it cannot run.
 *
 * Distinct from `UNFRAMED_PROMPT_EXIT` and from any vendor status, so the
 * container's exit code alone says which of the two refusals fired.
 */
export const RELAY_USAGE_EXIT = 64;

/** What the relay needs of a vendor, which is two functions and no more. */
export interface RelayVendor {
  readonly routeEvent: VendorSpawn["routeEvent"];
  readonly resumeFlags: VendorSpawn["resumeFlags"];
}

export interface RelayDeps {
  readonly input: Readable;
  readonly output: Writable;
  readonly errorOutput: Writable;
  spawn(
    binary: string,
    args: readonly string[],
  ): ChildProcessWithoutNullStreams;
  exit(code: number | null): void;
  /** Throws, naming what exists, for a vendor the registry does not have. */
  resolveVendor(name: string): RelayVendor;
}

interface RelayArgv {
  readonly vendor: string;
  readonly resumeSessionId?: string;
  readonly command: readonly string[];
}

/**
 * 🛑 A SEPARATOR, NOT A POSITIONAL TAIL. The vendor's own argv carries flags
 * this parser must never read — `--force`, `--model`, `--resume` among them —
 * so the boundary has to be explicit or a vendor flag becomes a relay flag.
 */
function parseArgv(argv: readonly string[]): RelayArgv | string {
  const separator = argv.indexOf("--");
  const own = separator === -1 ? argv : argv.slice(0, separator);
  const command = separator === -1 ? [] : argv.slice(separator + 1);

  let vendor: string | undefined;
  let resumeSessionId: string | undefined;

  for (let i = 0; i < own.length; i += 1) {
    const flag = own[i];

    if (flag === "--vendor") {
      vendor = own[i + 1];
      i += 1;
    } else if (flag === "--resume") {
      resumeSessionId = own[i + 1];
      i += 1;
    } else {
      return `turn-relay: unknown option '${flag}'`;
    }
  }

  if (!vendor)
    return "turn-relay: no --vendor was given, so no event router could be resolved";
  if (command.length === 0) {
    return "turn-relay: no command after '--', so there is nothing to run for a turn";
  }

  return { vendor, command, ...(resumeSessionId ? { resumeSessionId } : {}) };
}

export function relayMain(argv: readonly string[], deps: RelayDeps): void {
  const parsed = parseArgv(argv);

  if (typeof parsed === "string") {
    // 🛑 REFUSE LOUDLY RATHER THAN START A RELAY THAT CANNOT RUN A TURN. A
    // container that comes up and answers nothing is the #380 symptom itself,
    // so the cause goes on stderr and into the exit code.
    deps.errorOutput.write(`${parsed}\n`);
    deps.exit(RELAY_USAGE_EXIT);

    return;
  }

  const vendor = deps.resolveVendor(parsed.vendor);
  const [binary, ...baseArgs] = parsed.command;

  runTurnRelay({
    input: deps.input,
    output: deps.output,
    errorOutput: deps.errorOutput,
    routeEvent: vendor.routeEvent,
    ...(parsed.resumeSessionId
      ? { initialSessionId: parsed.resumeSessionId }
      : {}),
    // 🛑 THE BASE ARGV IS REUSED AND THE RESUME FLAGS ARE APPENDED PER TURN.
    // The host cannot bake `--resume` in, because the id it would use is only
    // known to the turn before this one.
    spawnTurn: ({ resumeSessionId }) =>
      deps.spawn(binary as string, [
        ...baseArgs,
        ...(resumeSessionId ? vendor.resumeFlags(resumeSessionId) : []),
      ]),
    exit: (code) => deps.exit(code),
  });
}

/** The slice of `process` the relay uses, so a test can hand it a fake. */
export interface RelayProcess {
  readonly stdin: Readable;
  readonly stdout: Writable;
  readonly stderr: Writable;
  exit(code: number): void;
}

/** How a turn is spawned, injectable so no test ever execs a paid CLI. */
export type TurnSpawn = (
  binary: string,
  args: readonly string[],
  options: { stdio: readonly string[] },
) => ChildProcessWithoutNullStreams;

/**
 * Everything `bin.ts` would otherwise decide, in one tested function.
 *
 * 🛑 THE STREAM ROLES ARE THE PART WORTH TESTING. The supervisor PARSES
 * stdout and shows stderr to the operator, so a swap turns every event into
 * operator noise and every diagnostic into a parse failure.
 */
export function relayDepsFromProcess(
  proc: RelayProcess,
  resolveVendor: (name: string) => RelayVendor,
  spawnTurn: TurnSpawn = spawnChild as unknown as TurnSpawn,
): RelayDeps {
  return {
    input: proc.stdin,
    output: proc.stdout,
    errorOutput: proc.stderr,
    spawn: (binary, args) =>
      spawnTurn(binary, args, { stdio: ["pipe", "pipe", "pipe"] }),
    // 🛑 NULL IS NOT ZERO. A turn killed by a signal reports a null code, and
    // exiting the container 0 for it would tell the supervisor the agent shut
    // down cleanly.
    exit: (code) => proc.exit(code ?? 1),
    resolveVendor,
  };
}
