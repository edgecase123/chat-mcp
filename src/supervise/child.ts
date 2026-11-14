import type { RateLimitSnapshot } from './rate-limit.js';
import type { ContextSnapshot } from './context-gauge.js';
import type { Denial } from './denial.js';
import type { ChildGrant } from './grant.js';

/**
 * 🛑 THE SEAM. NOTHING IN THIS FILE KNOWS ANY CLI's EVENT SHAPES.
 *
 * Claude Code signals turn completion with a `{"type":"result"}` stream-json
 * event. Cursor's ACP returns a `stopReason` on the `session/prompt` JSON-RPC
 * response — a protocol field, not an event to watch for. Each driver maps its
 * own signals onto the semantic callbacks below.
 *
 * ⚠️ THE CLAUDE-SPECIFIC HALF USED TO LIVE HERE, and so did a denial parser
 * that matched Claude's exact wording. A second driver would have had to
 * import Claude-named functions or duplicate them, which is the opposite of
 * what this seam is for. Moved to `drivers/claude.ts` on lee's instruction,
 * 2026-10-31: *"this should also work with cursor and that abstraction is
 * probably necessary in this logic"*.
 *
 * **A second driver is one file implementing `AgentChild`.**
 */
/**
 * The supervised agent process.
 *
 * Deliberately an interface so the supervisor can be driven by a FAKE child in
 * tests. A real `claude -p` run costs money and is non-deterministic, and a
 * fake that only lives in `tests/` is unreachable under a production install —
 * so this ships in `src/`.
 */
export interface AgentChild {
  /**
   * Whether this driver ever calls `onUsage`.
   *
   * 🛑 DECLARED, NOT INFERRED FROM SILENCE. The gate used to answer
   * `{allow: true, reason: 'unknown'}` whenever no snapshot had arrived — so a
   * driver whose CLI reports no limits got `unknown` FOREVER and dispatched
   * with no ceiling at all. **The Cursor driver this seam exists to enable is
   * exactly that driver.** Found by claude1 reviewing PR 34.
   *
   * `false` is allowed and is not a bug. It must be SAID, and the supervisor
   * says it out loud at startup, because an unmetered dispatcher is a choice
   * and not an accident. factory#3 already states the rule: a ceiling must
   * behave sanely when it cannot measure — refuse, or run unmetered, and say
   * which.
   */
  readonly reportsUsage: boolean;

  /**
   * This driver's CLI reports how full the context window is.
   *
   * 🛑 DECLARED, NOT INFERRED FROM SILENCE, for the same reason
   * `reportsUsage` is. A blank gauge used to have two causes an operator
   * could not tell apart: a driver that never reports, and reporting that
   * broke. Every other no-reading state logs — an unregistered child, a
   * throwing write, an unmapped model, a stale reading. Only this one could
   * not, because nothing said whether a figure was ever coming. #217.
   *
   * `false` is allowed and is not a bug. lee ruled on 2026-11-13:
   * *"dispatch and announce the blank"*. The supervisor says it at startup
   * and dispatches anyway, exactly as it does for an UNMETERED driver.
   */
  readonly reportsContext: boolean;

  /** Write one user message. Caller must not send another until the turn ends. */
  send(text: string): void;

  /**
   * The turn finished and another message may be sent.
   *
   * 🛑 SEMANTIC, NOT A RAW EVENT, AND THAT IS THE WHOLE POINT. Claude Code
   * signals completion with a `{"type":"result"}` stream-json event. Cursor's
   * ACP returns a `stopReason` on the `session/prompt` JSON-RPC response —
   * a protocol field, not an event to watch for.
   *
   * ⚠️ An earlier version had `TurnQueue` sniffing `event.type === 'result'`
   * itself. A Cursor driver would then NEVER end a turn, and the supervisor
   * would hang forever after the first message. **Each driver maps its own
   * signal to this; nothing above the driver knows either shape.**
   */
  onTurnEnd(cb: () => void): void;

  /**
   * Normalised usage-window state, for CLIs that report any.
   *
   * A driver whose CLI says nothing about limits simply never calls this, and
   * the gate stays at "unknown" — which it reports rather than treating as
   * fine.
   */
  onUsage(cb: (snapshot: RateLimitSnapshot) => void): void;

  /**
   * How full the child's context window is, for CLIs that report it.
   *
   * 🛑 SEMANTIC, LIKE onUsage, AND FOR A DIFFERENT WINDOW. `onUsage` is the
   * SUBSCRIPTION rate-limit window and gates dispatch; this is the CONTEXT
   * window and only drives the gauge an operator reads. Conflating them cost
   * a reader on #213, where both are called "usage" in the raw stream.
   *
   * A driver whose CLI reports no context simply never calls this. Which
   * driver that is comes from `reportsContext`, never from the silence.
   */
  onContext(cb: (snapshot: ContextSnapshot) => void): void;

  /**
   * The child was refused a tool and will not retry it this session.
   *
   * 🛑 SEMANTIC, LIKE onTurnEnd. Claude Code reports this as a `tool_result`
   * opening with a fixed English sentence. Another CLI will not, so each
   * driver maps its own signal onto the `Denial` type.
   *
   * ⚠️ Without this the supervisor cannot know the child has given up, and
   * "finished" and "blocked and silent" look identical.
   */
  onDenial(cb: (denial: Denial) => void): void;

  /**
   * The child's session id, once it is known, for `--resume`.
   *
   * 🛑 A GRANT KEEPS THE SESSION. Measured 2026-10-31: resuming works 3 of 3
   * with an explicit re-dispatch prompt, so a permission round trip does not
   * have to cost the child its memory of the task.
   */
  onSession(cb: (sessionId: string) => void): void;

  /** Raw driver events, for logging and diagnosis only. Never for control flow. */
  onEvent(cb: (event: Record<string, unknown>) => void): void;

  /**
   * Whatever the child wrote to `stderr`, as it arrives.
   *
   * 🛑 REQUIRED, SO A DRIVER CANNOT SILENTLY DROP IT. A containerized child
   * died with its reason on a stream nobody had attached to: the prelude
   * chains on `&&`, `npm` writes its errors here, and a failed install meant
   * no agent started with nothing saying why.
   *
   * ⚠️ NOT A SUBSTITUTE FOR `onEvent`. This is unstructured text for a human
   * reading a log, never for control flow — the same rule `onEvent` carries.
   */
  onStderr(cb: (chunk: string) => void): void;

  onExit(cb: (code: number | null, signal: string | null) => void): void;
  kill(): void;

  /**
   * Resolve once `kill()`'s teardown has actually finished.
   *
   * 🛑 SEPARATE FROM `kill()` ON PURPOSE, BECAUSE A RESTART MUST NOT WAIT.
   * `kill()` is best-effort and returns immediately: a containerized child
   * spawns `docker stop` detached, because PID 1 ignores SIGTERM and
   * `docker stop` then waits out its full `-t`. Blocking there froze the whole
   * supervisor for that minute.
   *
   * A stop is the one caller that wants the wait, since the process is leaving
   * anyway and the operator needs telling that the container is down.
   *
   * Optional. A driver with nothing to wait for omits it, and the old
   * non-blocking behaviour is what omitting it gives you.
   */
  awaitTeardown?(): Promise<void>;
}

/** Where a containerized child reaches the host bus, and the secret that lets it. */
export interface BusEndpoint {
  /** The HOST-side url, as `McpHttpListener.url` reports it. */
  readonly url: string;
  readonly token: string;
}

export interface SpawnOptions {
  /** Required for a containerized spawn that carries a grant. */
  readonly bus?: BusEndpoint;

  readonly binary?: string;
  readonly model?: string;
  readonly resumeSessionId?: string;
  readonly cwd?: string;
  /**
   * 🛑 DECIDED by lee 2026-10-16 for the spike: `plan` + `prompts none`.
   * `plan` reads and plans; it cannot edit or run anything. `prompts none`
   * means anything that WOULD prompt is denied automatically, so an agent
   * with no human at the terminal fails closed rather than stalling or
   * running unattended.
   */
  readonly permissionMode?: string;
  readonly permissionPrompts?: 'host' | 'none';

  /**
   * What the child may be and do. Omitted means it can be woken, cannot
   * reply, and cannot touch anything — which is the behaviour this exists to
   * end.
   */
  readonly grant?: ChildGrant;

  /**
   * The SUPERVISOR's own handle, so a driver that needs per-handle state
   * (registered mounts) can look it up. `grant.handle` is the CHILD's bus
   * handle (`<handle>-agent`) and is the wrong key for that lookup.
   */
  readonly supervisorHandle?: string;

  /**
   * Project-relative paths the container gets as nested READ-ONLY bind mounts,
   * layered over the read-write project mount.
   *
   * 🛑 THE PROJECT DECLARES THESE AND chat-mcp SHIPS NO DEFAULT. Deriving them
   * from a command's script path would encode one consumer's directory layout
   * — `dirname('scripts/gate.sh')` covers `scripts/lib/` only because that
   * project nests that way (lee, 2026-11-11).
   *
   * 🛑 THE GUARANTEE IS NARROW: the agent cannot change WHAT THE BROKER
   * INVOKES. It is not "the broker runs only trusted code" — the agent still
   * writes every other file, and a gate runs the agent's own application code.
   */
  readonly readOnlyPaths?: readonly string[];

  /**
   * Seconds between a shutdown notice and `kill()` (#149). For a
   * containerized child this is also `docker stop`'s `-t`. Default
   * `DEFAULT_SHUTDOWN_GRACE_SECONDS` (60), per-handle overridable.
   */
  readonly shutdownGraceSeconds?: number;
}

/**
 * Every capability on a child is SAID, in a boolean, or the spawn fails.
 *
 * 🛑 AN ABSENT FIELD IS NOT A `false`. It reads as `undefined`, which is
 * falsy, so the supervisor would announce the restrictive state — UNMETERED,
 * UNREPORTED — about a driver that never said anything. That is inference
 * from silence wearing a declaration's clothes, and it is the failure both
 * flags exist to end.
 *
 * 🛑 THE TYPE SYSTEM DOES NOT COVER THIS. `tsconfig.json` includes `src/**`
 * only, so a test fake or a JavaScript driver omitting a field compiles and
 * runs. Raised by claude2 reviewing PR 218: counting today's fakes fixes
 * today's fakes, not the one written next month.
 *
 * A DECLARED `false` is legal and is not an error — lee, 2026-11-13:
 * *"dispatch and announce the blank"*.
 */
export function assertDeclaresCapabilities(child: AgentChild): AgentChild {
  for (const field of ['reportsUsage', 'reportsContext'] as const) {
    if (typeof child[field] !== 'boolean') {
      throw new Error(
        `driver did not declare ${field}. A capability is declared, never inferred from silence: ` +
          `an absent field reads as undefined, and the supervisor would announce the restrictive ` +
          `state about a driver that said nothing. Set ${field} to true or false.`,
      );
    }
  }

  return child;
}

/** Split a byte stream into whole JSON lines. Partial lines are held back. */
export function createLineParser(
  onLine: (parsed: Record<string, unknown>) => void,
): (chunk: string) => void {
  let buffer = '';

  return (chunk: string): void => {
    buffer += chunk;

    let newline = buffer.indexOf('\n');

    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);

      if (line.length > 0) {
        try {
          onLine(JSON.parse(line) as Record<string, unknown>);
        } catch {
          // A non-JSON line on stdout is not fatal — the CLI may print
          // something unstructured. Dropping it is better than killing the
          // supervisor, and stderr is where real diagnostics go.
        }
      }

      newline = buffer.indexOf('\n');
    }
  };
}

