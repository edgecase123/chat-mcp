import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { dirsFor } from './projects.js';
import {
  isRecord,
  listCommands,
  readManifest,
  resolveArgv,
  type CommandManifest,
  type ListedCommand,
} from './commands.js';
import { checkedScriptPath } from './containment.js';
import { runScript, type ScriptResult, type ScriptRunner } from './run-script.js';

/** Where a project declares the commands it offers, relative to its directory. */
export const MANIFEST_RELATIVE = join('.chat-mcp', 'commands.json');

/**
 * 🛑 LOOPBACK IS NOT THE BOUNDARY. A container reaches a host `127.0.0.1` bind
 * through `host.docker.internal` on Docker Desktop, measured. The token is what
 * separates callers; this only keeps the broker off the operator's LAN.
 */
const BIND_ADDRESS = '127.0.0.1';

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_MAX_BUFFER = 8 * 1024 * 1024;
const DEFAULT_MAX_IN_FLIGHT = 4;
const DEFAULT_MAX_CONNECTIONS = 8;
const DEFAULT_IDLE_TIMEOUT_MS = 60 * 1000;

/**
 * The longest envelope accepted before the connection is dropped.
 *
 * A peer that never sends a newline would otherwise grow the read buffer
 * without limit, which is memory exhaustion from inside a container.
 */
const MAX_LINE = 64 * 1024;

export interface BrokerOptions {
  /**
   * 🛑 THE CALLER'S IDENTITY COMES FROM ITS SECRET, NEVER FROM A FIELD IT
   * FILLS IN. Return the handle a token belongs to, or null to refuse.
   *
   * 🛑 COMPARE IN CONSTANT TIME. The obvious `token === stored` leaks the
   * shared prefix through timing, and this is the only boundary there is. Use
   * `crypto.timingSafeEqual` on equal-length buffers. Throttling repeated
   * failures is the caller's job too — the broker drops the connection and
   * nothing stops an immediate reconnect.
   */
  readonly authenticate: (token: string) => string | null;
  readonly timeoutMs?: number;
  readonly maxBuffer?: number;
  /** Dispatches allowed to be in flight at once, across all connections. */
  readonly maxInFlight?: number;
  readonly maxConnections?: number;
  /** How long a connection may sit with NOTHING in flight before it is closed. */
  readonly idleTimeoutMs?: number;
  /** Test seam; see `run-script.ts`. */
  readonly run?: ScriptRunner;
}

/**
 * A refusal with two faces: what the caller is told, and what the operator can
 * read in the host's log.
 *
 * 🛑 THE CALLER NEVER SEES A HOST PATH. A collaborator's message names absolute
 * directories and says whether a path exists and what it resolved to — and the
 * caller writes the manifest, so forwarding that turns the broker into an
 * arbitrary-path existence and realpath oracle for the whole host.
 */
class Refusal extends Error {
  readonly detail: string;

  constructor(publicMessage: string, cause?: unknown) {
    super(publicMessage);
    this.name = 'Refusal';
    this.detail = cause instanceof Error ? cause.message : String(cause ?? publicMessage);
  }
}

/**
 * The one directory a handle's commands come from.
 *
 * 🛑 TWO CANDIDATES IS A REFUSAL. `dirsFor` returns an array, and taking the
 * first would silently run a command in a tree the operator did not mean —
 * the failure `dirsFor`'s own docblock exists to prevent.
 */
function projectDirFor(handle: string): string {
  let dirs: string[];

  try {
    dirs = dirsFor(handle);
  } catch (err) {
    throw new Refusal('no project directory is configured for this agent', err);
  }

  const withManifest = dirs.filter((dir) => existsSync(join(dir, MANIFEST_RELATIVE)));

  if (withManifest.length === 0) {
    throw new Refusal(
      'this project offers no commands',
      new Error(`no ${MANIFEST_RELATIVE} in ${dirs.join(', ')}`),
    );
  }

  if (withManifest.length > 1) {
    throw new Refusal(
      'this agent has commands in more than one project, so the broker refuses to guess',
      new Error(`manifests in ${withManifest.join(', ')}`),
    );
  }

  return withManifest[0] as string;
}

/**
 * The host-side listener a containerized agent asks to run a project command.
 *
 * 🛑 A SEPARATE CLASS FROM `WakeListener`, DELIBERATELY. Merging them would put
 * this authentication check on the wake path, where every delivery would pay
 * for it and a bug would stop messages rather than refuse commands.
 *
 * 🛑 THE PROJECT DIRECTORY IS TRUSTED INPUT AND TODAY IT IS NOT TRUSTWORTHY.
 * A containerized agent holds it read-write, so it can rewrite a manifest
 * script's CONTENT and the broker runs that content on the host. Measured, with
 * no symlink and no race. `checkedScriptPath` stops the manifest NAMING a path
 * outside the tree; it cannot make an in-tree script safe. Whether a project
 * script may be trusted at all is the open decision that blocks slice 3.
 */
export class CommandBroker {
  readonly address = BIND_ADDRESS;

  private readonly server: Server;
  private readonly options: BrokerOptions;
  /** Tracked so `close()` can end them; see the test naming `cancelled 1`. */
  private readonly open = new Set<Socket>();
  private boundPort = 0;
  private inFlight = 0;

  private constructor(server: Server, options: BrokerOptions) {
    this.server = server;
    this.options = options;
  }

  static async bind(options: BrokerOptions): Promise<CommandBroker> {
    const server = createServer();
    const broker = new CommandBroker(server, options);

    server.maxConnections = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
    server.on('connection', (socket) => broker.accept(socket));

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, BIND_ADDRESS, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });

    broker.boundPort = (server.address() as AddressInfo).port;

    return broker;
  }

  get port(): number {
    return this.boundPort;
  }

  async close(): Promise<void> {
    for (const socket of this.open) socket.destroy();
    this.open.clear();

    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private get timeoutMs(): number {
    return this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private get maxBuffer(): number {
    return this.options.maxBuffer ?? DEFAULT_MAX_BUFFER;
  }

  private accept(socket: Socket): void {
    this.open.add(socket);
    socket.once('close', () => this.open.delete(socket));

    // 🛑 THE IDLE TIMEOUT IS ARMED ONLY WHILE NOTHING IS IN FLIGHT. A gate runs
    // for minutes with no bytes on the wire, so a plain idle timeout would kill
    // the connection while it waits for the answer it asked for.
    const idle = this.options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    const decoder = new StringDecoder('utf8');
    let buffer = '';
    let pending = 0;

    const armIdle = () => {
      if (socket.destroyed) return;
      socket.setTimeout(pending === 0 ? idle : 0);
    };

    socket.on('timeout', () => socket.destroy());
    socket.on('error', () => socket.destroy());
    armIdle();

    socket.on('data', (chunk: Buffer) => {
      buffer += decoder.write(chunk);

      for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
        if (socket.destroyed) return;

        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        pending += 1;
        armIdle();

        void this.handleLine(socket, line)
          .catch(() => socket.destroy())
          .finally(() => {
            pending -= 1;
            armIdle();
          });
      }

      // 🛑 AN OVERSIZED LINE IS NEVER PARSED. The check has to sit after the
      // drain so a complete line is handled first, and it must clear the
      // buffer: a cap that only bounds the RESIDUE still lets the oversized
      // line reach `JSON.parse`, which is what made this guard's first test
      // vacuous.
      if (buffer.length > MAX_LINE) {
        buffer = '';
        socket.destroy();
      }
    });
  }

  /**
   * 🛑 AN UNAUTHENTICATED CALLER IS ANSWERED WITH NOTHING AT ALL. An error
   * envelope would confirm the port is a broker and that the request shape was
   * right, which is what a probe is looking for.
   */
  private async handleLine(socket: Socket, line: string): Promise<void> {
    const trimmed = line.trim();

    if (trimmed.length === 0) return;

    let envelope: unknown;

    try {
      envelope = JSON.parse(trimmed);
    } catch {
      socket.destroy();

      return;
    }

    if (!isRecord(envelope) || typeof envelope.token !== 'string') {
      socket.destroy();

      return;
    }

    let handle: unknown;

    // 🛑 INSIDE A TRY. `authenticate` is supplied by the caller of `bind`, and a
    // throw from it out here becomes an unhandled rejection that takes the
    // supervisor down — with a caller-controlled token as the trigger.
    try {
      handle = this.options.authenticate(envelope.token);
    } catch {
      socket.destroy();

      return;
    }

    // 🛑 A NON-EMPTY STRING, NOT "not null". `undefined` from a `Map.get` miss
    // or from a missing `return` would otherwise AUTHENTICATE, and the declared
    // `string | null` is not enforced on a value that arrives from config.
    if (typeof handle !== 'string' || handle.length === 0) {
      socket.destroy();

      return;
    }

    const id = typeof envelope.id === 'number' ? envelope.id : null;

    // 🛑 ONE WRITE CAN CARRY MANY ENVELOPES, AND EACH ONE SPAWNS A HOST
    // PROCESS. Without this, a single chunk of N run-commands starts N
    // processes, each allowed the full timeout and output budget.
    if (this.inFlight >= (this.options.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT)) {
      this.reply(socket, { id, ok: false, error: 'the broker is busy; retry' });

      return;
    }

    this.inFlight += 1;

    try {
      this.reply(socket, { id, ok: true, ...(await this.dispatch(handle, envelope)) });
    } catch (err) {
      if (err instanceof Refusal) {
        console.error(`broker refused a request from "${handle}": ${err.detail}`);
        this.reply(socket, { id, ok: false, error: err.message });
      } else {
        console.error(`broker failed a request from "${handle}": ${String(err)}`);
        this.reply(socket, { id, ok: false, error: 'the broker could not run that command' });
      }
    } finally {
      this.inFlight -= 1;
    }
  }

  private async dispatch(
    handle: string,
    envelope: Record<string, unknown>,
  ): Promise<{ commands: ListedCommand[] } | ScriptResult> {
    if (envelope.op === 'list-commands') {
      return { commands: listCommands(this.manifestFor(handle).manifest) };
    }

    if (envelope.op === 'run-command') {
      return this.runCommand(handle, envelope);
    }

    throw new Refusal('unknown op');
  }

  private manifestFor(handle: string): { dir: string; manifest: CommandManifest } {
    const dir = projectDirFor(handle);

    try {
      return { dir, manifest: readManifest(join(dir, MANIFEST_RELATIVE)) };
    } catch (err) {
      throw new Refusal('this project has no usable command manifest', err);
    }
  }

  private async runCommand(
    handle: string,
    envelope: Record<string, unknown>,
  ): Promise<ScriptResult> {
    if (typeof envelope.name !== 'string') {
      throw new Refusal('run-command needs a string "name"');
    }

    const params = envelope.params ?? {};

    if (!isRecord(params)) {
      throw new Refusal('run-command "params" must be an object');
    }

    const { dir, manifest } = this.manifestFor(handle);

    // The caller named this command and supplied these values, so this message
    // discloses only what it already knows.
    let resolved;

    try {
      resolved = resolveArgv(manifest, envelope.name, params as Record<string, string>);
    } catch (err) {
      throw new Refusal(err instanceof Error ? err.message : 'the command was refused', err);
    }

    // 🛑 THE ONLY WAY TO A PATH. `resolved.script` is an object, so reaching the
    // runner without this call is a compile error rather than a missing symlink
    // check.
    let script: string;

    try {
      script = checkedScriptPath(dir, resolved.script);
    } catch (err) {
      throw new Refusal('the command script is not inside the project directory', err);
    }

    try {
      return await runScript(
        script,
        resolved.argv,
        { cwd: dir, timeout: this.timeoutMs, maxBuffer: this.maxBuffer },
        this.options.run,
      );
    } catch (err) {
      throw new Refusal(err instanceof Error ? err.message : 'the command failed to run', err);
    }
  }

  private reply(socket: Socket, payload: Record<string, unknown>): void {
    if (socket.destroyed) return;

    socket.write(`${JSON.stringify(payload)}\n`);
  }
}
