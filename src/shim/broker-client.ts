import { connect, type Socket } from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import { isRecord } from '../supervise/commands.js';

/**
 * 🛑 BOTH ARE `-e` VALUES, NEVER PATHS. The whole state directory is mounted
 * into every container, so a token FILE would let one handle read another's
 * secret and run commands in that handle's tree.
 */
const PORT_VAR = 'CHAT_MCP_BROKER_PORT';
const TOKEN_VAR = 'CHAT_MCP_BROKER_TOKEN';

/**
 * Longer than the broker's own 15-minute script timeout, deliberately.
 *
 * A gate runs for minutes with nothing on the wire. A client deadline below the
 * broker's would report a timeout for a command that was still running and
 * about to answer.
 */
const DEFAULT_DEADLINE_MS = 16 * 60 * 1000;

/** The same cap the broker applies, so an oversized reply fails here too. */
const MAX_LINE = 64 * 1024;

export interface BrokerAddress {
  readonly port: number;
  readonly token: string;
}

export const NO_BROKER = 'this agent is not running under a command broker';
export const REFUSED = 'the command broker is not accepting connections';
export const CLOSED_SILENTLY = 'the command broker closed the connection without answering';

/**
 * Where the broker is, or null when this session has no broker at all.
 *
 * 🛑 NULL IS THE NORMAL CASE. Every session outside a supervised container has
 * neither variable, so this is a capability check and not an error path.
 */
export function brokerAddress(env: NodeJS.ProcessEnv = process.env): BrokerAddress | null {
  const token = env[TOKEN_VAR];
  const port = Number(env[PORT_VAR]);

  if (typeof token !== 'string' || token.length === 0) return null;

  // A non-numeric or out-of-range port is absence, not a fault: there is no
  // broker to reach either way, and the caller's one job is to say so.
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;

  return { port, token };
}

export interface AskOptions {
  readonly address: BrokerAddress;
  readonly deadlineMs?: number;
}

/**
 * One request, one connection, one reply.
 *
 * 🛑 THE BROKER ANSWERS SIX CLASSES OF BAD REQUEST WITH NOTHING AT ALL —
 * malformed JSON, a missing token, a throwing `authenticate`, a handle that is
 * not a non-empty string, an oversized line, and its own idle timeout. The
 * caller cannot tell them apart and must not try: every one of them arrives
 * here as the socket closing with no matching reply.
 *
 * 🛑 ONE REQUEST PER CONNECTION, ON PURPOSE. The broker caps connections and
 * arms its idle timeout only while nothing is in flight, so a pooled socket
 * buys nothing and costs a reconnect-storm question nobody has answered.
 */
export function askBroker(
  op: string,
  body: Record<string, unknown>,
  opts: AskOptions,
): Promise<Record<string, unknown>> {
  const { address } = opts;
  const deadline = opts.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const id = nextId();

  return new Promise((resolve, reject) => {
    const socket = connect({ port: address.port, host: '127.0.0.1' });
    const decoder = new StringDecoder('utf8');
    let buffer = '';
    let settled = false;

    const finish = (err: Error | null, payload?: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (err) reject(err);
      else resolve(payload ?? {});
    };

    socket.setTimeout(deadline, () => finish(new Error(CLOSED_SILENTLY)));

    // Only a refused CONNECT means nothing is listening. A reset mid-stream is
    // a connection that existed and then stopped answering, which is the same
    // thing as a silent close from the caller's side.
    socket.on('error', (err: NodeJS.ErrnoException) => {
      finish(new Error(err.code === 'ECONNREFUSED' ? REFUSED : CLOSED_SILENTLY));
    });

    // 🛑 THE ONLY THING THAT SETTLES A SILENT REFUSAL, AND THE DEADLINE ABOVE
    // IS NOT A BACKSTOP FOR IT. Measured by deleting this line: a destroyed
    // socket emits no `timeout`, so the promise never settles and the caller
    // hangs forever instead of failing at `deadlineMs`.
    socket.on('close', () => finish(new Error(CLOSED_SILENTLY)));

    socket.on('data', (chunk: Buffer) => {
      buffer += decoder.write(chunk);

      for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);

        const reply = parseReply(line);

        // A reply for another id cannot happen on a single-request connection,
        // and dropping it is still right: it is not the answer we asked for.
        if (reply === null || reply.id !== id) continue;

        if (reply.ok) finish(null, reply.payload);
        else finish(new Error(reply.error));

        return;
      }

      if (buffer.length > MAX_LINE) {
        buffer = '';
        finish(new Error(CLOSED_SILENTLY));
      }
    });

    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ id, token: address.token, op, ...body })}\n`);
    });
  });
}

let counter = 0;

const nextId = (): number => (counter += 1);

interface Reply {
  readonly id: number;
  readonly ok: boolean;
  readonly error: string;
  readonly payload: Record<string, unknown>;
}

/** Null for anything that is not a reply envelope, so the caller keeps reading. */
function parseReply(line: string): Reply | null {
  const trimmed = line.trim();

  if (trimmed.length === 0) return null;

  let envelope: unknown;

  try {
    envelope = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (!isRecord(envelope) || typeof envelope.id !== 'number') return null;

  const { id, ok, error, ...payload } = envelope;

  return {
    id,
    ok: ok === true,
    // The broker's own sentence, verbatim. It is written for this caller and
    // is the only part of a refusal that may cross the boundary.
    error: typeof error === 'string' && error.length > 0 ? error : CLOSED_SILENTLY,
    payload,
  };
}
