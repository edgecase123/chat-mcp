import { createServer, connect, type Server, type Socket } from 'node:net';
import { existsSync, unlinkSync } from 'node:fs';
import { ensureSocketDir, socketPathFor } from '../util/paths.js';

/**
 * Direct delivery to a running supervisor.
 *
 * 🛑 WHY THIS EXISTS RATHER THAN A FILE WATCH. The notify file is a mailbox
 * for an agent that is running nothing. A supervisor is a live process with an
 * address, so the mailbox stops being necessary — and it was never reliable.
 * Measured on 2026-10-16 (edgecase123/chat-mcp#33), chokidar on the notify
 * file with the same options `NotifyBus` uses:
 *
 *   writes: 10   watch events: 2   LOST SIGNALS: 8
 *   file holds only: {"id":10}
 *
 * Ten messages back to back produced two wakes, and the file overwrites, so
 * nine envelopes were gone. Three faults, one cause — the event carries no
 * reliable payload: no ack, nothing filterable before a turn is spent, and
 * dropped signals.
 *
 * ⚠️ SQLite remains the durable store. This is a WAKE, not a store. A message
 * whose delivery fails is still in the database and is picked up on catch-up.
 */

/**
 * An operator's answer to a permission request.
 *
 * 🛑 A TYPED FIELD, NOT A PARSED BODY STRING. The answer arrives on the same
 * wake path as a chat message, and without this the supervisor renders it as
 * prose and the re-dispatch template — the one measured at 3 of 3 — never
 * runs. Found by claude1: the dead-link guard covered two of three links and
 * therefore read as "the path is whole".
 */
export interface ApprovalAnswer {
  readonly approvalId: number;
  readonly decision: 'approve' | 'deny';
  /** The command, VERBATIM, as the operator saw and approved it. */
  readonly requested: string;
  /** The child session to resume, so a grant is not a restart. */
  readonly sessionId: string | null;
}

export interface WakeEnvelope {
  readonly id: number;
  readonly to: string;
  readonly from: string;
  readonly ts: number;
  /** The message itself, so the receiver need not re-read the database. */
  readonly body?: string;
  /** `chat` | `dispatch` | `alert`. An alert must not arrive as chat. */
  readonly kind?: string;

  /**
   * An operator's answer to a permission request. Absent for a chat wake.
   *
   * 🛑 TYPED, NOT PARSED OUT OF `body`. Without it the answer reaches the
   * agent as a sentence and the re-dispatch template never runs.
   */
  readonly approval?: ApprovalAnswer;
}

export interface WakeAck {
  readonly ok: boolean;
  readonly queued?: 'sent' | 'queued' | 'duplicate' | 'held';
  readonly error?: string;
}

const ACK_TIMEOUT_MS = 2_000;

/**
 * A supervisor's listening end.
 *
 * One JSON envelope per line in, one JSON ack per line out. Newline-delimited
 * rather than length-prefixed because every producer here is Node and the
 * payloads are small.
 */
export class WakeListener {
  private readonly server: Server;
  private readonly path: string;
  /**
   * 🛑 Every accepted connection, tracked so `close()` can end them.
   *
   * `server.close()` stops ACCEPTING but then waits for every open
   * connection, and this listener deliberately keeps them open to read more
   * than one line — so a sender that stays connected makes `close()` hang
   * forever. `net.Server` has no `closeAllConnections()`; that is
   * `http.Server`. Found by a test that CANCELLED rather than failed:
   * `tests 10, pass 9, fail 0, cancelled 1`, which reads as green to anyone
   * checking only `fail`.
   */
  private readonly open = new Set<Socket>();

  private constructor(server: Server, path: string) {
    this.server = server;
    this.path = path;
  }

  /**
   * Bind the socket for `handle`.
   *
   * 🛑 A stale socket file is the normal case, not the exception — a crashed
   * supervisor leaves one behind and `listen` then fails EADDRINUSE. So probe
   * it first: if nothing answers, the file is debris and is removed. If
   * something DOES answer, another supervisor owns this handle and we must
   * refuse rather than steal its deliveries.
   */
  static async bind(
    handle: string,
    onEnvelope: (envelope: WakeEnvelope) => WakeAck | Promise<WakeAck>,
  ): Promise<WakeListener> {
    ensureSocketDir();
    const path = socketPathFor(handle);

    if (existsSync(path)) {
      if (await isLive(path)) {
        throw new Error(
          `another supervisor is already listening for [${handle}] at ${path}; refusing to steal its deliveries`,
        );
      }
      unlinkSync(path);
    }

    const open = new Set<Socket>();
    const server = createServer((socket: Socket) => {
      open.add(socket);
      socket.once('close', () => open.delete(socket));
      handleConnection(socket, onEnvelope);
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });

    const listener = new WakeListener(server, path);
    for (const s of open) listener.open.add(s);
    // The set is mutated by later connections, so share the same instance.
    server.on('connection', (socket: Socket) => {
      listener.open.add(socket);
      socket.once('close', () => listener.open.delete(socket));
    });

    return listener;
  }

  get socketPath(): string {
    return this.path;
  }

  async close(): Promise<void> {
    for (const socket of this.open) socket.destroy();
    this.open.clear();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    // Leaving the file behind makes the next bind look like a live rival.
    try {
      if (existsSync(this.path)) unlinkSync(this.path);
    } catch {
      // Best-effort. `bind` probes for liveness, so debris is recoverable.
    }
  }
}

function handleConnection(
  socket: Socket,
  onEnvelope: (envelope: WakeEnvelope) => WakeAck | Promise<WakeAck>,
): void {
  let buffer = '';

  socket.setEncoding('utf8');
  socket.on('error', () => socket.destroy());
  socket.on('data', (chunk: string) => {
    buffer += chunk;

    let newline = buffer.indexOf('\n');

    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      void respond(socket, line, onEnvelope);
      newline = buffer.indexOf('\n');
    }
  });
}

async function respond(
  socket: Socket,
  line: string,
  onEnvelope: (envelope: WakeEnvelope) => WakeAck | Promise<WakeAck>,
): Promise<void> {
  let ack: WakeAck;

  try {
    const parsed = JSON.parse(line) as WakeEnvelope;

    if (typeof parsed?.id !== 'number' || typeof parsed?.to !== 'string') {
      ack = { ok: false, error: 'envelope needs a numeric id and a string to' };
    } else {
      ack = await onEnvelope(parsed);
    }
  } catch (err) {
    // 🛑 An ack is sent even on a parse failure. A sender waiting on a reply
    // that never comes blocks for the full timeout and then cannot tell a
    // malformed payload from a dead supervisor.
    ack = { ok: false, error: err instanceof Error ? err.message : 'unparseable envelope' };
  }

  try {
    socket.write(`${JSON.stringify(ack)}\n`);
  } catch {
    // The sender hung up; nothing to report it to.
  }
}

/** Is anything actually answering on this socket path? */
async function isLive(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = connect(path);
    const finish = (live: boolean): void => {
      probe.destroy();
      resolve(live);
    };
    probe.once('connect', () => finish(true));
    probe.once('error', () => finish(false));
    setTimeout(() => finish(false), 250);
  });
}

/**
 * Try to hand an envelope straight to `handle`'s supervisor.
 *
 * Returns the ack on success, or null when no supervisor is listening — which
 * is the normal case for an agent running on a harness watch. **The caller
 * falls back to `notifyPeer()`; it must not treat null as a failure.**
 */
export async function deliverToSupervisor(
  handle: string,
  envelope: WakeEnvelope,
  timeoutMs: number = ACK_TIMEOUT_MS,
): Promise<WakeAck | null> {
  const path = socketPathFor(handle);

  if (!existsSync(path)) return null;

  return new Promise((resolve) => {
    let settled = false;
    let buffer = '';

    const socket = connect(path);

    const finish = (result: WakeAck | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };

    // 🛑 A hung supervisor must not block the sender. Without this the shim
    // stalls on every send and the bus looks broken rather than unsupervised.
    const timer = setTimeout(() => finish(null), timeoutMs);

    socket.setEncoding('utf8');
    socket.on('error', () => finish(null));
    socket.on('close', () => finish(null));
    socket.on('connect', () => socket.write(`${JSON.stringify(envelope)}\n`));
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');

      if (newline === -1) return;

      try {
        finish(JSON.parse(buffer.slice(0, newline)) as WakeAck);
      } catch {
        finish(null);
      }
    });
  });
}
