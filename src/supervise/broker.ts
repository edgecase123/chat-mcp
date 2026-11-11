import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { dirsFor } from './projects.js';
import { listCommands, readManifest, resolveArgv, type ListedCommand } from './commands.js';
import { checkedScriptPath } from './containment.js';

/** Where a project declares the commands it offers, relative to its directory. */
export const MANIFEST_RELATIVE = join('.chat-mcp', 'commands.json');

/**
 * 🛑 LOOPBACK, NOT THE BOUNDARY. A container reaches a host `127.0.0.1` bind
 * through `host.docker.internal` on Docker Desktop, measured. The token is what
 * separates callers; this keeps the broker off the operator's LAN.
 */
const BIND_ADDRESS = '127.0.0.1';

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_MAX_BUFFER = 8 * 1024 * 1024;

/**
 * The longest envelope accepted before the connection is dropped.
 *
 * A peer that never sends a newline would otherwise grow this buffer without
 * limit, which is a memory exhaustion from inside a container.
 */
const MAX_LINE = 64 * 1024;

export interface BrokerOptions {
  /**
   * 🛑 THE CALLER'S IDENTITY COMES FROM ITS SECRET, NEVER FROM A FIELD IT
   * FILLS IN. Return the handle a token belongs to, or null to refuse.
   */
  readonly authenticate: (token: string) => string | null;
  readonly timeoutMs?: number;
  readonly maxBuffer?: number;
}

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The one directory a handle's commands come from.
 *
 * 🛑 TWO CANDIDATES IS A REFUSAL. `dirsFor` returns an array, and taking the
 * first would silently run a command in a tree the operator did not mean —
 * the failure `dirsFor`'s own docblock exists to prevent.
 */
function projectDirFor(handle: string): string {
  const dirs = dirsFor(handle);
  const withManifest = dirs.filter((dir) => existsSync(join(dir, MANIFEST_RELATIVE)));

  if (withManifest.length === 0) {
    throw new Error(
      `no command manifest for "${handle}": expected ${MANIFEST_RELATIVE} in ${dirs.join(', ')}`,
    );
  }

  if (withManifest.length > 1) {
    throw new Error(
      `"${handle}" has a command manifest in two registered directories, so the broker ` +
        `refuses to guess: ${withManifest.join(', ')}`,
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
  /** Tracked so `close()` can end them; see the test that names `cancelled 1`. */
  private readonly open = new Set<Socket>();
  private boundPort = 0;

  private constructor(server: Server, options: BrokerOptions) {
    this.server = server;
    this.options = options;
  }

  static async bind(options: BrokerOptions): Promise<CommandBroker> {
    const server = createServer();
    const broker = new CommandBroker(server, options);

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

    let buffer = '';

    socket.on('error', () => socket.destroy());
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();

      for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        void this.handleLine(socket, line);
      }

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

    const handle = this.options.authenticate(envelope.token);

    if (handle === null) {
      socket.destroy();

      return;
    }

    const id = typeof envelope.id === 'number' ? envelope.id : null;

    try {
      this.reply(socket, { id, ok: true, ...(await this.dispatch(handle, envelope)) });
    } catch (err) {
      this.reply(socket, {
        id,
        ok: false,
        error: err instanceof Error ? err.message : 'the broker refused the request',
      });
    }
  }

  private async dispatch(
    handle: string,
    envelope: Record<string, unknown>,
  ): Promise<{ commands: ListedCommand[] } | RunResult> {
    if (envelope.op === 'list-commands') {
      return { commands: listCommands(this.manifestFor(handle).manifest) };
    }

    if (envelope.op === 'run-command') {
      return this.runCommand(handle, envelope);
    }

    throw new Error(`unknown op "${String(envelope.op)}"`);
  }

  private manifestFor(handle: string) {
    const dir = projectDirFor(handle);

    return { dir, manifest: readManifest(join(dir, MANIFEST_RELATIVE)) };
  }

  private async runCommand(
    handle: string,
    envelope: Record<string, unknown>,
  ): Promise<RunResult> {
    if (typeof envelope.name !== 'string') {
      throw new Error('run-command needs a string "name"');
    }

    const params = envelope.params ?? {};

    if (!isRecord(params)) {
      throw new Error('run-command "params" must be an object');
    }

    const { dir, manifest } = this.manifestFor(handle);
    const resolved = resolveArgv(manifest, envelope.name, params as Record<string, string>);

    // 🛑 THE ONLY WAY TO A PATH. `resolved.script` is an object, so handing it
    // to `execFile` without this call is a compile error rather than a missing
    // symlink check.
    const script = checkedScriptPath(dir, resolved.script);

    return this.run(script, resolved.argv, dir);
  }

  /**
   * 🛑 A NON-ZERO EXIT IS AN ANSWER, NOT AN ERROR. A gate that fails is the
   * result the caller asked for, and reporting it as a refusal would make a
   * failing gate indistinguishable from a rejected request.
   */
  private run(script: string, argv: readonly string[], cwd: string): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      execFile(
        script,
        [...argv],
        { cwd, timeout: this.timeoutMs, maxBuffer: this.maxBuffer },
        (err, stdout, stderr) => {
          if (err === null) {
            resolve({ exitCode: 0, stdout, stderr });

            return;
          }

          const failure = err as Error & { code?: number | string; killed?: boolean };

          if (failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
            reject(new Error(`command output exceeded ${this.maxBuffer} bytes`));

            return;
          }

          if (failure.killed === true) {
            reject(new Error(`command timed out after ${this.timeoutMs}ms`));

            return;
          }

          if (typeof failure.code === 'number') {
            resolve({ exitCode: failure.code, stdout, stderr });

            return;
          }

          reject(new Error(failure.message));
        },
      );
    });
  }

  private reply(socket: Socket, payload: Record<string, unknown>): void {
    if (socket.destroyed) return;

    socket.write(`${JSON.stringify(payload)}\n`);
  }
}
