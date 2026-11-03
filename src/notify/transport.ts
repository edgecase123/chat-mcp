import { notifyPathFor } from '../util/paths.js';

/**
 * 🛑 THE SEAM BETWEEN "A WAKE ARRIVED" AND "HOW IT ARRIVED".
 *
 * Delivery was already abstracted: every sender calls `notifyPeer`, which
 * fans out to whatever transports exist. SUBSCRIPTION was not — the Claude
 * Code adapter built `require('fs').watch(<path>)` itself, so each new
 * adapter re-hardcoded the file watch and moving off it meant editing all
 * of them.
 *
 * An adapter now asks the active transport how to subscribe and renders
 * whatever it is told. It never names a mechanism.
 */

/** How a host arms a wake. One shape today; a socket or an HTTP stream adds
 *  its own rather than bending this one. */
export interface WakeSubscription {
  /** A long-running process whose stdout lines are wakes. */
  readonly kind: 'process';
  /** Verbatim command for the host to run. */
  readonly command: string;
  /** Shown in host UI, so it says what is being watched. */
  readonly description: string;
  /** How long the host should keep it armed before re-arming. */
  readonly timeoutMs: number;
  /** Where wakes land, when the transport has such a place. Adapters may
   *  mention it; they must not reconstruct the command from it. */
  readonly endpoint?: string;
}

export interface WakeTransport {
  readonly id: string;
  /** One line an adapter can put in front of the command. */
  readonly summary: (handle: string) => string;
  readonly subscribe: (handle: string) => WakeSubscription;
}

// 🛑 MATCHES THE HOST'S CAP, AND IS NOT A PREFERENCE. Monitor silently caps a
// deadline at 30 minutes, so asking for an hour printed an hour into the hook
// and the watch still died at half the advertised life. A dead watcher is
// indistinguishable from a quiet queue, which is the failure this value had.
const MONITOR_MAX_MS = 1_800_000;

/**
 * The wake command: print the message, and drop only a repeat of the same id.
 *
 * 🛑 THE BODY IS WHY THIS IS NOT A BARE `wake`. A wake with no payload cannot
 * be triaged, so every one of them costs an `inbox` round trip just to learn
 * whether it mattered.
 *
 * 🛑 THE DEDUPE IS GUARDED BY `id > 0` AND THAT GUARD IS THE WHOLE POINT.
 * `notifyPeer` writes `id: 0` for system events and a bare millisecond when it
 * has no envelope, so a dedupe on content or on a raw `id` would silently drop
 * a second wake. Dropping a wake looks exactly like a peer that never replied.
 */
function watchCommand(path: string): string {
  const js =
    `const fs=require('fs'),p='${path}';let seen=0;` +
    'fs.watch(p,()=>{' +
    "let s='';try{s=fs.readFileSync(p,'utf8').trim()}catch{return}" +
    'if(!s)return;' +
    'let id=0;try{id=JSON.parse(s).id|0}catch{}' +
    'if(id>0){if(id===seen)return;seen=id}' +
    'console.log(s)})';

  return `node -e "${js}"`;
}

/** Today's transport: a file per handle, whose writes are the wakes. */
export const fileWatchTransport: WakeTransport = {
  id: 'file-watch',
  summary: (handle) =>
    `Incoming messages for "${handle}" land in ${notifyPathFor(handle)}`,
  subscribe: (handle) => {
    const path = notifyPathFor(handle);

    return {
      kind: 'process',
      command: watchCommand(path),
      description: `chat-mcp inbound for ${handle}`,
      timeoutMs: MONITOR_MAX_MS,
      endpoint: path,
    };
  },
};

const TRANSPORTS: Record<string, WakeTransport> = {
  [fileWatchTransport.id]: fileWatchTransport,
};

/**
 * The transport in use. `CHAT_MCP_WAKE_TRANSPORT` selects another one once
 * another exists; an unknown name falls back rather than leaving a host with
 * no wake at all, because a silent non-wake is indistinguishable from a peer
 * choosing not to reply.
 */
export function activeWakeTransport(): WakeTransport {
  const requested = process.env.CHAT_MCP_WAKE_TRANSPORT;

  return (requested && TRANSPORTS[requested]) || fileWatchTransport;
}

/** Exposed for tests, which need a transport that is not the real one. */
export function registerWakeTransport(transport: WakeTransport): void {
  TRANSPORTS[transport.id] = transport;
}
