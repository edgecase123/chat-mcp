/**
 * Resolve a handle from an explicit CLI flag, falling back to
 * `$CHAT_MCP_HANDLE`. Throws with a clear message if neither is set.
 */
export function resolveHandle(explicit: string | undefined, flagName: string): string {
  const value = explicit ?? process.env.CHAT_MCP_HANDLE;
  if (!value || value.length === 0) {
    throw new Error(`${flagName} required (or set CHAT_MCP_HANDLE)`);
  }
  return value;
}

// timeOf lives at src/util/time.ts as stampOf now — kept re-export here
// for the one-shot CLI callers that import from `./common`.
export { stampOf as timeOf } from '../util/time.js';

/**
 * Drain stdin to a UTF-8 string. Strips a single trailing newline so
 * `echo "hi" | chat-send lee -` sends "hi" not "hi\n".
 */
export async function readStdinAll(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw.endsWith('\n') ? raw.slice(0, -1) : raw;
}
