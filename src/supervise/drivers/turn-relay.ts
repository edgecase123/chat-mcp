import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { Readable, Writable } from "node:stream";

/**
 * The container-side half of a per-turn vendor.
 *
 * 🛑 IT EXISTS BECAUSE THE SUPERVISOR'S STDIN AND `cursor-agent`'s DISAGREE
 * ABOUT LIFETIME. `wireAgentChild` writes one line to one long-lived stdin and
 * never closes it; `cursor-agent -p` reads stdin to EOF and treats the whole of
 * it as ONE prompt. Wired together directly the agent blocks on an EOF that
 * never comes and emits zero frames — #380.
 *
 * So this runs as the container's command, keeps the container alive across
 * turns, and gives each turn its own process with its own EOF.
 *
 * 🛑 ONE CONTAINER, NOT ONE PER TURN, AND THAT IS lee's RULING OF 2026-11-21.
 * A container per turn would re-do the MCP handshake and `--approve-mcps` every
 * turn, which is the work #372 exists to have made succeed once.
 */

/** Marks the end of one turn in the vendor's own event stream. */
const TURN_END = /"type"\s*:\s*"result"/;

/**
 * One prompt as one line, whatever bytes it contains.
 *
 * 🛑 BASE64, NOT NEWLINE-TERMINATED TEXT. `cursorEncodeInput` is the identity
 * function, so a prompt's own newlines are indistinguishable from a prompt
 * boundary — and a multi-line prompt read as several turns is silent.
 */
export function frameTurn(prompt: string): string {
  return `${Buffer.from(prompt, "utf8").toString("base64")}\n`;
}

/** The inverse of {@link frameTurn}. */
export function unframeTurn(line: string): string {
  return Buffer.from(line, "base64").toString("utf8");
}

export interface TurnRelayIo {
  /** The container's own stdin, carrying framed prompts from the supervisor. */
  readonly input: Readable;
  /** The container's own stdout, which is the stream the supervisor parses. */
  readonly output: Writable;
  /** Kept SEPARATE from `output`: the fan-out treats stderr as operator text. */
  readonly errorOutput?: Writable;
  spawnTurn(prompt: string): ChildProcessWithoutNullStreams;
  /** Ends the relay, and with it the container. */
  exit(code: number | null): void;
}

/** Split a buffer into whole lines, returning the unterminated remainder. */
function takeLines(buffered: string): {
  lines: string[];
  rest: string;
} {
  const parts = buffered.split("\n");
  const rest = parts.pop() ?? "";

  return { lines: parts, rest };
}

export function runTurnRelay(io: TurnRelayIo): void {
  let pending = "";

  io.input.setEncoding("utf8");
  io.input.on("data", (chunk: string) => {
    const { lines, rest } = takeLines(pending + chunk);
    pending = rest;

    for (const line of lines) {
      if (line.trim().length > 0) startTurn(io, unframeTurn(line));
    }
  });

  function startTurn(relay: TurnRelayIo, prompt: string): void {
    const child = relay.spawnTurn(prompt);
    let sawTurnEnd = false;
    let tail = "";

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      // Passed through FIRST and unchanged. The supervisor's parser owns this
      // stream; scanning it here must not reshape it.
      relay.output.write(chunk);

      const { lines, rest } = takeLines(tail + chunk);
      tail = rest;

      for (const line of lines) if (TURN_END.test(line)) sawTurnEnd = true;
    });

    if (relay.errorOutput) {
      const errors = relay.errorOutput;
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => errors.write(chunk));
    }

    // 🛑 WRITE THEN END, IN THAT ORDER AND ALWAYS. The `end` is the EOF the
    // agent is waiting for, and it is the entire fix for #380.
    child.stdin.write(prompt);
    child.stdin.end();

    child.on("exit", (code: number | null) => {
      // 🛑 A FINAL RESULT LINE WITH NO TRAILING NEWLINE STILL ENDS THE TURN.
      // A long-lived child's next chunk releases a partial line; a per-turn
      // child has no next chunk, so the remainder is checked here or never.
      if (TURN_END.test(tail)) sawTurnEnd = true;

      // 🛑 ROW 3 OF `per-turn.ts`'s TABLE, AND IT IS THE LOAD-BEARING ONE.
      // `cursor-agent` without `--trust` exits 1 having emitted nothing.
      // Reporting that as a turn end would advance the supervisor's queue past
      // a prompt that was never answered, so it propagates as a death.
      if (!sawTurnEnd) relay.exit(code);
    });
  }
}
