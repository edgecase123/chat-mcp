import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { parseRateLimitEvent, type RateLimitSnapshot } from './rate-limit.js';

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
}

/**
 * Build the argv for a supervised `claude` child.
 *
 * Exported separately from the spawn so the flag set is assertable without
 * launching a process or spending anything.
 *
 * ⚠️ `--verbose` is NOT optional. Measured on 2026-10-16: without it the
 * process exits 1 with
 *   `When using --print, --output-format=stream-json requires --verbose`
 * and that requirement appears in no `--help` text for either flag.
 */
export function claudeArgs(opts: SpawnOptions = {}): string[] {
  const args = [
    '-p',
    '--verbose',
    '--output-format',
    'stream-json',
    '--input-format',
    'stream-json',
    '--permission-mode',
    opts.permissionMode ?? 'plan',
    '--permission-prompts',
    opts.permissionPrompts ?? 'none',
  ];

  if (opts.model) args.push('--model', opts.model);
  if (opts.resumeSessionId) args.push('--resume', opts.resumeSessionId);

  return args;
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

/**
 * Map ONE parsed Claude Code event onto the semantic callbacks.
 *
 * 🛑 EXPORTED SO IT CAN BE TESTED WITHOUT SPAWNING. A negative control that
 * deleted this mapping from inside `spawnClaude` broke NOTHING, because every
 * supervisor test drives a fake child that signals turn-end directly. The
 * fake bypassed the only Claude-specific logic left in the system.
 *
 * ⚠️ A second driver writes its own version of this function and nothing else
 * changes. That is the seam.
 */
export function routeClaudeEvent(
  event: Record<string, unknown>,
  on: { turnEnd(): void; usage(snapshot: RateLimitSnapshot): void },
): void {
  const usage = parseRateLimitEvent(event);

  if (usage) on.usage(usage);

  // `result` is Claude Code's terminal event. An `assistant` event with no
  // following `result` is a turn still in flight.
  if (event.type === 'result') on.turnEnd();
}

export function spawnClaude(opts: SpawnOptions = {}): AgentChild {
  const child: ChildProcessWithoutNullStreams = spawn(
    opts.binary ?? 'claude',
    claudeArgs(opts),
    { cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'] },
  ) as ChildProcessWithoutNullStreams;

  const eventCbs: ((e: Record<string, unknown>) => void)[] = [];
  const turnEndCbs: (() => void)[] = [];
  const usageCbs: ((s: RateLimitSnapshot) => void)[] = [];

  const feed = createLineParser((parsed) => {
    for (const cb of eventCbs) cb(parsed);

    routeClaudeEvent(parsed, {
      turnEnd: () => {
        for (const cb of turnEndCbs) cb();
      },
      usage: (snapshot) => {
        for (const cb of usageCbs) cb(snapshot);
      },
    });
  });

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', feed);

  return {
    // Claude Code emits `rate_limit_event` unprompted, so this driver meters.
    reportsUsage: true,
    send(text: string): void {
      // The documented streaming-input shape: one JSON user message per line.
      const message = {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text }] },
      };
      child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    onTurnEnd(cb): void {
      turnEndCbs.push(cb);
    },
    onUsage(cb): void {
      usageCbs.push(cb);
    },
    onEvent(cb): void {
      eventCbs.push(cb);
    },
    onExit(cb): void {
      child.on('exit', (code, signal) => cb(code, signal));
    },
    kill(): void {
      child.kill();
    },
  };
}
