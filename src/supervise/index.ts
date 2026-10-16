import type { AgentChild, SpawnOptions } from './child.js';
import { spawnClaude } from './child.js';
import { TurnQueue } from './turn-queue.js';
import { WakeListener, type WakeAck, type WakeEnvelope } from './socket.js';

/**
 * The supervisor: it owns the loop the harness used to own.
 *
 * A message arriving no longer needs the host to convert a background
 * process's stdout into a turn. This process listens, and writes into a
 * long-lived child's stdin.
 */
export interface SupervisorOptions extends SpawnOptions {
  readonly handle: string;
  /** Injected so the supervisor is testable without spawning or spending. */
  readonly spawnChild?: (opts: SpawnOptions) => AgentChild;
  readonly log?: (line: string) => void;
}

export interface Supervisor {
  readonly socketPath: string;
  /** Prompts accepted but not yet written to the child. */
  readonly queueDepth: number;
  stop(): Promise<void>;
}

/** How an arriving message is presented to the agent. */
export function formatPrompt(envelope: WakeEnvelope): string {
  const from = envelope.from || 'unknown';
  const body = envelope.body?.trim();
  const where = envelope.to.startsWith('#') ? ` in ${envelope.to}` : '';

  // 🛑 An `alert` is BLOCKING by this bus's own definition. Rendering it the
  // same as a chat message loses the urgency at the layer built to deliver it
  // faster, so the escalation is in the prompt text and not left to the
  // agent to infer from a field it may not read.
  const banner =
    envelope.kind === 'alert'
      ? '🚨 ALERT — BLOCKING. This was sent as high-severity; handle it before anything queued behind it.\n\n'
      : envelope.kind === 'dispatch'
        ? '📋 DISPATCH — a task hand-off, not a status update.\n\n'
        : '';

  if (!body) {
    // 🛑 No body means this came through the FALLBACK file path, which
    // overwrites and carries no payload. Say so rather than inventing one —
    // the agent must know to go and read the bus itself.
    return `${banner}[chat-mcp] ${from}${where} sent you something (id ${envelope.id}). The wake carried no body, so read your inbox.`;
  }

  return `${banner}[chat-mcp] ${from}${where}:\n\n${body}`;
}

export async function startSupervisor(opts: SupervisorOptions): Promise<Supervisor> {
  const log = opts.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const spawnFn = opts.spawnChild ?? spawnClaude;

  const child = spawnFn(opts);

  const queue = new TurnQueue({
    send: (prompt) => {
      log(`→ child: ${prompt.text.slice(0, 80).replace(/\n/g, ' ')}`);
      child.send(prompt.text);
    },
  });

  child.onEvent((event) => {
    queue.onEvent(event);

    if (event.type === 'result') {
      log(`← turn complete; ${queue.depth} queued`);
    }
  });

  child.onExit((code, signal) => {
    // 🛑 Anything queued is UNSENT. Reporting it is the difference between a
    // visible gap and silence, and silence is the ambiguity this whole change
    // exists to remove.
    const unsent = queue.drain();
    log(`child exited code=${code} signal=${signal}; ${unsent.length} prompt(s) never sent`);

    for (const p of unsent) log(`  UNSENT ids=[${p.messageIds.join(',')}]`);
  });

  const listener = await WakeListener.bind(opts.handle, (envelope): WakeAck => {
    const queued = queue.offer({
      text: formatPrompt(envelope),
      messageIds: envelope.id > 0 ? [envelope.id] : [],
    });

    // The ack tells the SENDER what happened, which a file write never could.
    return { ok: true, queued };
  });

  log(`supervisor listening for [${opts.handle}] at ${listener.socketPath}`);

  return {
    socketPath: listener.socketPath,
    get queueDepth(): number {
      return queue.depth;
    },
    async stop(): Promise<void> {
      await listener.close();
      child.kill();
    },
  };
}
