import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import type { VendorSpawn } from "../vendor.js";

/**
 * The container-side half of a per-turn vendor.
 *
 * 🛑 IT EXISTS BECAUSE THE SUPERVISOR'S STDIN AND `cursor-agent`'s DISAGREE
 * ABOUT LIFETIME. `wireAgentChild` writes one prompt to a long-lived stdin and
 * never closes it; `cursor-agent -p` reads stdin to EOF and treats the whole of
 * it as ONE prompt. Wired together the agent blocks on an EOF that never comes
 * and emits zero frames — #380.
 *
 * So this runs as the container's command, keeps the container alive across
 * turns, and gives each turn its own process with its own EOF.
 *
 * 🛑 ONE CONTAINER, NOT ONE PER TURN, AND THAT IS lee's RULING OF 2026-11-21.
 * A container per turn would re-do the MCP handshake and `--approve-mcps` every
 * turn, which is the work #372 exists to have made succeed once.
 */

/**
 * The relay's own exit code for a line on stdin that was never framed.
 *
 * Distinct from any `cursor-agent` status, so the cause is readable from the
 * container's exit alone.
 */
export const UNFRAMED_PROMPT_EXIT = 65;

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

/**
 * The inverse of {@link frameTurn}, or null for a line that was never framed.
 *
 * 🛑 IT VALIDATES BY ROUND TRIP, BECAUSE DECODING CANNOT FAIL.
 * `Buffer.from(x, "base64")` ignores every character outside the alphabet
 * rather than throwing, so an unframed `"review PR 384 please"` decodes to
 * binary garbage and the agent answers a prompt nobody wrote. Re-encoding and
 * comparing is the only check that rejects it. claude2 on PR 384.
 */
export function unframeTurn(line: string): string | null {
  const trimmed = line.trim();
  const decoded = Buffer.from(trimmed, "base64");

  return decoded.toString("base64") === trimmed
    ? decoded.toString("utf8")
    : null;
}

/** One turn's spawn request: the prompt, and the session it continues. */
export interface TurnRequest {
  readonly prompt: string;
  /**
   * ⚠️ UNDEFINED ON THE FIRST TURN OF A FRESH AGENT, AND THAT IS NOT THE ONLY
   * CASE. A relay started by a RESTART carries the id it was asked to resume,
   * so turn one of that relay continues a session rather than starting one —
   * the same fallback `host.ts` records for the host path.
   */
  readonly resumeSessionId?: string;
}

export interface TurnRelayIo {
  /** The container's own stdin, carrying framed prompts from the supervisor. */
  readonly input: Readable;
  /** The container's own stdout, which is the stream the supervisor parses. */
  readonly output: Writable;
  /** Kept SEPARATE from `output`: the fan-out treats stderr as operator text. */
  readonly errorOutput?: Writable;
  /**
   * 🛑 THE SUPERVISOR'S OWN ROUTER, NOT A SECOND OPINION ABOUT TURN ENDS.
   * A private matcher here can DISAGREE with the one the supervisor runs, and
   * a disagreement in this direction — relay says the turn ended, supervisor
   * says it did not — leaves the child gone, the container alive and the queue
   * `inTurn` forever, which `index.ts` already names as a state it reached
   * once. Sharing the function makes that unrepresentable. claude2 on PR 384.
   */
  readonly routeEvent: VendorSpawn["routeEvent"];
  /**
   * The id a RESTART was asked to resume, if any. Turn one has no event to
   * read an id from, so this is the only place it can come from.
   */
  readonly initialSessionId?: string;
  spawnTurn(turn: TurnRequest): ChildProcessWithoutNullStreams;
  /** Ends the relay, and with it the container. */
  exit(code: number | null): void;
}

/** Split a buffer into whole lines, returning the unterminated remainder. */
function takeLines(buffered: string): { lines: string[]; rest: string } {
  const parts = buffered.split("\n");
  const rest = parts.pop() ?? "";

  return { lines: parts, rest };
}

export function runTurnRelay(io: TurnRelayIo): void {
  let pending = "";

  /**
   * 🛑 ACROSS TURNS, NOT PER TURN, AND THE RELAY IS THE ONLY PARTY THAT CAN
   * HOLD IT. Each turn is its own process and its exit happens inside the
   * container, so the supervisor never sees a turn boundary to carry an id
   * over. Without this every turn is a fresh session and the agent forgets the
   * task between turns while still looking busy.
   */
  let sessionId = io.initialSessionId;

  io.input.setEncoding("utf8");
  io.input.on("data", (chunk: string) => {
    const { lines, rest } = takeLines(pending + chunk);
    pending = rest;

    for (const line of lines) {
      if (line.trim().length === 0) continue;

      const prompt = unframeTurn(line);

      if (prompt === null) {
        // 🛑 REFUSE LOUDLY RATHER THAN ANSWER GARBAGE, AND EXIT RATHER THAN
        // DROP IT. `per-turn.ts` records the house rule for this shape: a
        // dropped prompt that names itself beats a silent hang. Returning here
        // instead would leave the supervisor's queue waiting on a turn that
        // will never start.
        io.errorOutput?.write(
          "turn-relay: a line on stdin was not a framed prompt, so no turn " +
            "was started; the supervisor and this relay disagree about framing\n",
        );
        io.exit(UNFRAMED_PROMPT_EXIT);

        return;
      }

      startTurn(io, prompt);
    }
  });

  function startTurn(relay: TurnRelayIo, prompt: string): void {
    const child = relay.spawnTurn({ prompt, resumeSessionId: sessionId });
    let sawTurnEnd = false;
    let tail = "";

    /** The supervisor's verdict on one line, never this file's own. */
    const readLine = (line: string): void => {
      let event: unknown;

      try {
        event = JSON.parse(line);
      } catch {
        // Not an event. The supervisor's parser skips it too.
        return;
      }

      if (typeof event !== "object" || event === null) return;

      relay.routeEvent(event as Record<string, unknown>, {
        turnEnd: () => {
          sawTurnEnd = true;
        },
        // The supervisor owns these. The relay only needs the turn boundary,
        // and a router that calls them must still find them callable.
        usage: () => undefined,
        context: () => undefined,
        denial: () => undefined,
        // 🔴 ONLY EVER ASSIGNED, NEVER CLEARED. The router calls this only
        // when an event carries a string id, so a turn whose events omit the
        // field leaves the held id alone instead of dropping the session.
        session: (id: string) => {
          sessionId = id;
        },
      });
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      // Passed through FIRST and unchanged. The supervisor's parser owns this
      // stream; reading it here must not reshape it.
      relay.output.write(chunk);

      const { lines, rest } = takeLines(tail + chunk);
      tail = rest;

      for (const line of lines) readLine(line);
    });

    if (relay.errorOutput) {
      const errors = relay.errorOutput;
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => errors.write(chunk));
    }

    // 🛑 A SPAWN FAILURE EMITS `error` AND NO `exit`, so without this the
    // relay dies of an uncaught exception and the supervisor gets node's
    // status instead of the cause. claude2 on PR 384.
    child.on("error", (err: Error) => {
      relay.errorOutput?.write(
        `turn-relay: the turn failed to start: ${err.message}\n`,
      );
      relay.exit(1);
    });

    // 🛑 WRITE THEN END, IN THAT ORDER AND ALWAYS. The `end` is the EOF the
    // agent is waiting for, and it is the entire fix for #380.
    child.stdin.write(prompt);
    child.stdin.end();

    child.on("exit", (code: number | null) => {
      // 🛑 A FINAL EVENT WITH NO TRAILING NEWLINE STILL ENDS THE TURN. A
      // long-lived child's next chunk releases a partial line; a per-turn child
      // has no next chunk, so the remainder is read here or never.
      if (tail.trim().length > 0) readLine(tail);

      // 🛑 ROW 3 OF `per-turn.ts`'s TABLE, AND IT IS THE LOAD-BEARING ONE.
      // `cursor-agent` without `--trust` exits 1 having emitted nothing.
      // Reporting that as a turn end would advance the supervisor's queue past
      // a prompt that was never answered, so it propagates as a death.
      if (!sawTurnEnd) relay.exit(code);
    });
  }
}
