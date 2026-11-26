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

export type TurnState = "idle" | "inTurn";

export interface QueuedPrompt {
  /** What gets written to the child. */
  readonly text: string;
  /** Bus message ids this prompt covers, for de-duplication. */
  readonly messageIds: readonly number[];
  /**
   * The peer owed a reply, when one DM'd this agent directly.
   *
   * 🛑 A DM ONLY, AND `undefined` FOR A ROOM POST. `roomClause` tells a room
   * reader that silence is a valid response, so announcing an unanswered room
   * post would contradict the instruction the bus itself gave. #472.
   */
  readonly owedTo?: string;
}

export interface TurnQueueEvents {
  /** Called when a prompt should be written to the child's stdin. */
  send(prompt: QueuedPrompt): void;
}

export class TurnQueue {
  private state: TurnState = "idle";
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
  offer(prompt: QueuedPrompt): "sent" | "queued" | "duplicate" {
    const fresh = prompt.messageIds.filter((id) => !this.seen.has(id));

    if (prompt.messageIds.length > 0 && fresh.length === 0) {
      return "duplicate";
    }

    for (const id of fresh) this.seen.add(id);

    return this.dispatch(prompt);
  }

  /**
   * Re-offer a prompt this queue already drained, skipping the gate above.
   *
   * 🛑 `offer` REFUSES ITS OWN DRAINED PROMPTS. Their ids are in `seen` from
   * the first offer and `drain()` does not remove them, so a respawn's
   * carry-over returned `duplicate` and the operator's unsent work was
   * discarded. `replaceChild`'s docblock asserted the opposite.
   *
   * ⚠️ The gate is SKIPPED, not cleared. A drained prompt was never written
   * to a child, so sending it once is correct — and leaving the id in `seen`
   * keeps the bus's own re-reads de-duplicated afterwards.
   */
  reoffer(prompt: QueuedPrompt): "sent" | "queued" {
    return this.dispatch(prompt);
  }

  /**
   * Hold a prompt for a child that does not exist yet, dispatching nothing.
   *
   * 🛑 A FAILED RESPAWN HAS NO CHILD TO WRITE TO. Re-offering into an idle
   * queue would write straight to the process that was just killed, which
   * loses the prompt exactly as discarding it did. Parking marks the queue
   * busy instead, so nothing dispatches until a `drain()` releases it to a
   * child that is really there.
   */
  park(prompt: QueuedPrompt): void {
    this.state = "inTurn";
    this.pending.push(prompt);
  }

  /** Send now when idle, queue behind the running turn otherwise. */
  private dispatch(prompt: QueuedPrompt): "sent" | "queued" {
    if (this.state === "idle") {
      this.state = "inTurn";
      this.events.send(prompt);

      return "sent";
    }

    this.pending.push(prompt);

    return "queued";
  }

  /**
   * The driver says the turn ended. Release whatever is queued.
   *
   * 🛑 NO EVENT SHAPE IS KNOWN HERE, DELIBERATELY. This used to sniff
   * `event.type === 'result'`, which is Claude Code's terminal event.
   *
   * ⚠️ `cursor-agent` TURNED OUT TO SPELL IT THE SAME WAY, so that shortcut
   * would now pass for both shipped vendors — and that is exactly why it is
   * still wrong. The next CLI that disagrees would never end a turn and the
   * supervisor would hang after its first message. **The driver decides what
   * completion looks like; this only reacts to it.**
   */
  turnEnded(): void {
    this.state = "idle";

    const next = this.pending.shift();

    if (next) {
      this.state = "inTurn";
      this.events.send(next);
    }
  }

  /**
   * The child died or the stream closed. Anything queued is unsent and the
   * caller needs to know rather than find a silent gap.
   */
  drain(): QueuedPrompt[] {
    const unsent = this.pending.splice(0, this.pending.length);
    this.state = "idle";

    return unsent;
  }
}
