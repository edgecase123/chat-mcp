/**
 * One turn at a time, with a queue.
 *
 * 🛑 THE WHOLE REASON THIS FILE EXISTS. Writing two user messages into a
 * `claude -p --input-format stream-json` child produces ONE turn, not two.
 * Measured on 2026-10-16 (edgecase123/chat-mcp#33):
 *
 *   $ grep -c '"type":"result"' stream.jsonl
 *   1
 *
 * The model consumed both lines and ran a single loop, answering only the
 * second question. The naive implementation — write as messages arrive —
 * silently merges turns and loses the earlier one. There is no error.
 *
 * So: send one, wait for the terminal `result` event, then send the next.
 * Separated from the process wiring so it is testable without spawning a
 * child or spending money.
 */

export type TurnState = 'idle' | 'inTurn';

export interface QueuedPrompt {
  /** What gets written to the child. */
  readonly text: string;
  /** Bus message ids this prompt covers, for de-duplication. */
  readonly messageIds: readonly number[];
}

export interface TurnQueueEvents {
  /** Called when a prompt should be written to the child's stdin. */
  send(prompt: QueuedPrompt): void;
}

export class TurnQueue {
  private state: TurnState = 'idle';
  private readonly pending: QueuedPrompt[] = [];
  private readonly seen = new Set<number>();

  constructor(private readonly events: TurnQueueEvents) {}

  get currentState(): TurnState {
    return this.state;
  }

  get depth(): number {
    return this.pending.length;
  }

  /**
   * Offer a prompt. Sends immediately when idle, queues otherwise.
   *
   * ⚠️ Message ids already offered are dropped. The notify file fires on
   * every write, and two writes can land before one turn finishes, so the
   * same message is re-read from the bus more than once. Without this the
   * agent is asked the same question twice.
   */
  offer(prompt: QueuedPrompt): 'sent' | 'queued' | 'duplicate' {
    const fresh = prompt.messageIds.filter((id) => !this.seen.has(id));

    if (prompt.messageIds.length > 0 && fresh.length === 0) {
      return 'duplicate';
    }

    for (const id of fresh) this.seen.add(id);

    if (this.state === 'idle') {
      this.state = 'inTurn';
      this.events.send(prompt);

      return 'sent';
    }

    this.pending.push(prompt);

    return 'queued';
  }

  /**
   * The driver says the turn ended. Release whatever is queued.
   *
   * 🛑 NO EVENT SHAPE IS KNOWN HERE, DELIBERATELY. This used to sniff
   * `event.type === 'result'`, which is Claude Code's terminal event and
   * nobody else's. Cursor's ACP returns a `stopReason` on a JSON-RPC
   * response, so a Cursor driver would never have ended a turn and the
   * supervisor would have hung after the first message. **The driver decides
   * what completion looks like; this only reacts to it.**
   */
  turnEnded(): void {
    this.state = 'idle';

    const next = this.pending.shift();

    if (next) {
      this.state = 'inTurn';
      this.events.send(next);
    }
  }

  /**
   * The child died or the stream closed. Anything queued is unsent and the
   * caller needs to know rather than find a silent gap.
   */
  drain(): QueuedPrompt[] {
    const unsent = this.pending.splice(0, this.pending.length);
    this.state = 'idle';

    return unsent;
  }
}
