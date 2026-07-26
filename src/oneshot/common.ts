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

/**
 * Format an epoch-ms timestamp as HH:MM:SS for terminal output.
 */
export function timeOf(ts: number): string {
  return new Date(ts).toTimeString().slice(0, 8);
}

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
