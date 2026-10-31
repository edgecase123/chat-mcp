import type { RateLimitSnapshot } from './rate-limit.js';
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

  onExit(cb: (code: number | null, signal: string | null) => void): void;
  kill(): void;
}

export interface SpawnOptions {
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

