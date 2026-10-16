import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

/**
 * The supervised agent process.
 *
 * Deliberately an interface so the supervisor can be driven by a FAKE child in
 * tests. A real `claude -p` run costs money and is non-deterministic, and a
 * fake that only lives in `tests/` is unreachable under a production install —
 * so this ships in `src/`.
 */
export interface AgentChild {
  /** Write one user message. Caller must not send another until `result`. */
  send(text: string): void;
  /** Every parsed stream-json event from the child's stdout. */
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

export function spawnClaude(opts: SpawnOptions = {}): AgentChild {
  const child: ChildProcessWithoutNullStreams = spawn(
    opts.binary ?? 'claude',
    claudeArgs(opts),
    { cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'] },
  ) as ChildProcessWithoutNullStreams;

  const eventCbs: ((e: Record<string, unknown>) => void)[] = [];
  const feed = createLineParser((parsed) => {
    for (const cb of eventCbs) cb(parsed);
  });

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', feed);

  return {
    send(text: string): void {
      // The documented streaming-input shape: one JSON user message per line.
      const message = {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text }] },
      };
      child.stdin.write(`${JSON.stringify(message)}\n`);
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
