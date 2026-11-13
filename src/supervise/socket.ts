import { createServer, connect, type Server, type Socket } from 'node:net';
import { chmodSync, existsSync, unlinkSync } from 'node:fs';
import { SOCKET_MODE, ensureSocketDir, socketPathFor } from '../util/paths.js';
import { supervisorHandleFor } from './grant.js';

/**
 * Direct delivery to a running supervisor.
 *
 * 🛑 WHY THIS EXISTS RATHER THAN A FILE WATCH. The notify file is a mailbox
 * for an agent that is running nothing. A supervisor is a live process with an
 * address, so the mailbox stops being necessary — and it was never reliable.
 * Measured on 2026-10-16 (edgecase123/chat-mcp#33), chokidar on the notify
 * file with the options `NotifyBus` used AT THE TIME. It polls now, partly
 * because of this measurement:
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

  /**
   * The allowlist entry to add, or null when the pairing failed.
   *
   * 🛑 NOT `requested`. The operator reads prose; the CLI reads
   * `Tool(invocation)`. Sending the prose grants nothing.
   */
  readonly grant: string | null;

  /**
   * Every equivalent spelling of `grant`, all of which are allowlisted.
   *
   * 🛑 `/var/x` and `/private/var/x` are the same file. Granting only the
   * spelling the operator saw leaves the other denied — measured live.
   */
  readonly grantForms?: readonly string[];
  /** The child session to resume, so a grant is not a restart. */
  readonly sessionId: string | null;
}

/**
 * An out-of-band restart command for a running child.
 *
 * `graceful` tells the child to externalize state in its current turn, then
 * waits for that turn to end before killing and respawning. `now` kills and
 * respawns immediately, no notice.
 */
export interface RestartControl {
  readonly kind: 'restart';
  readonly mode: 'graceful' | 'now';
}

/**
 * An out-of-band stop command for a running supervisor.
 *
 * Same two modes as a restart, with no respawn afterwards. It exists because
 * the operator's own Ctrl-C does not always reach the supervise process, and
 * `kill -INT` from a second terminal was the only confirmed way out.
 */
export interface StopControl {
  readonly kind: 'stop';
  readonly mode: 'graceful' | 'now';
}

export type SupervisorControl = RestartControl | StopControl;

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

  /** An out-of-band control command, e.g. a CLI-initiated restart or stop. Absent for a chat wake or an approval. */
  readonly control?: SupervisorControl;
}

export interface WakeAck {
  readonly ok: boolean;
  readonly queued?: 'sent' | 'queued' | 'duplicate' | 'held';
  readonly error?: string;

  /**
   * The supervisor's own shutdown grace, in seconds, on a stop ack.
   *
   * 🛑 THE CLI MUST NOT KEEP ITS OWN COPY OF THE DEFAULT. `shutdownGraceSeconds`
   * is overridable per handle, so a CLI computing its wait ceiling from the
   * default gives up first and reports failure on a stop that is working.
   * Found by claude2 reviewing PR #158.
   */
  readonly graceSeconds?: number;
}

const ACK_TIMEOUT_MS = 2_000;

/**
 * Refuse when another supervisor is already listening for `handle`.
 *
 * 🛑 SEPARATE FROM `bind` SO A CALLER CAN REFUSE BEFORE IT SPAWNS. `bind`
 * runs late in `startSupervisor`, and a containerized spawn clears its
 * container name with `docker rm -f` — a name derived from the handle alone.
 * So a second supervisor used to SIGKILL the first one's agent and only then
 * find out it was not allowed to start (#154).
 *
 * A stale socket file is not a rival. Nothing answering means the file is
 * debris, and this returns without touching it — removing it is `bind`'s job,
 * so a caller that only wants to ask cannot destroy anything.
 */
export async function refuseIfSupervisorLive(handle: string): Promise<void> {
  const path = socketPathFor(handle);
  if (!existsSync(path)) return;

  if (await isLive(path)) {
    throw new Error(
      `another supervisor is already listening for [${handle}] at ${path}; refusing to steal its deliveries`,
    );
  }
}

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

    await refuseIfSupervisorLive(handle);
    // Whatever is left is debris a crashed supervisor abandoned.
    if (existsSync(path)) unlinkSync(path);

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

    // 🛑 listen() CREATES THE FILE AT THE UMASK MODE, so this can only follow
    // it and a window exists in between. The 0700 socket DIRECTORY is what
    // covers that window; this is the second layer, and it is what `stat`
    // shows an auditor.
    chmodSync(path, SOCKET_MODE);

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
/**
 * The socket to hand an envelope to, or `null` when nothing is listening.
 *
 * 🛑 A CHILD HANDLE FALLS BACK TO ITS SUPERVISOR, AND THAT IS THE WHOLE ARC.
 * A supervised child is registered on the bus as `<handle>-agent` while the
 * supervisor binds `<handle>` — deliberately, so the child cannot eat the
 * deliveries meant for its supervisor (#35). On the host that costs nothing,
 * because the child's own shim watches `notify/<handle>-agent`.
 *
 * 🛑 A CONTAINERIZED CHILD WATCHES NO NOTIFY FILE. The state dir is not
 * mounted into it, so this socket is its only wake path. Without the fallback
 * every message addressed to it returned `null` here and was dropped with no
 * error on either side.
 *
 * The direct socket is tried FIRST, so a real supervisor whose own handle ends
 * in `-agent` still wins over the one it would otherwise be mistaken for.
 */
function supervisorSocketFor(handle: string): string | null {
  const direct = socketPathFor(handle);

  if (existsSync(direct)) return direct;

  const owner = supervisorHandleFor(handle);

  if (owner === null) return null;

  const viaOwner = socketPathFor(owner);

  return existsSync(viaOwner) ? viaOwner : null;
}

export async function deliverToSupervisor(
  handle: string,
  envelope: WakeEnvelope,
  timeoutMs: number = ACK_TIMEOUT_MS,
): Promise<WakeAck | null> {
  const path = supervisorSocketFor(handle);

  if (path === null) return null;

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
