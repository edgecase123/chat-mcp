import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

interface McpServerEntry {
  command?: string;
  args?: unknown;
}

interface McpJson {
  mcpServers?: Record<string, McpServerEntry>;
}

// The handle appears on chat-mcp's own CLI (`chat-mcp --handle X` or
// `npx github:edgecase123/chat-mcp --handle X`). Any server entry whose args
// carry a --handle flag counts — key name is a hint, not a contract.
const CHAT_SERVER_KEY_HINTS = ['chat', 'chat-mcp'];

export interface DetectedHandle {
  serverKey: string;
  handle: string;
  sourcePath: string;
}

function extractHandle(args: unknown): string | null {
  if (!Array.isArray(args)) return null;
  const idx = args.indexOf('--handle');
  if (idx < 0 || idx + 1 >= args.length) return null;
  const next = args[idx + 1];
  return typeof next === 'string' && next.length > 0 ? next : null;
}

/**
 * Read `<cwd>/.mcp.json` and return the chat server's --handle if present.
 * Returns null when the file is missing, unparseable, or lacks a chat entry.
 * Prefers keys matching `chat` / `chat-mcp`, falling back to any entry whose
 * args carry --handle (covers non-standard key names).
 */
export function detectChatHandleInCwd(cwd: string): DetectedHandle | null {
  const path = join(cwd, '.mcp.json');
  if (!existsSync(path)) return null;

  let parsed: McpJson;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as McpJson;
  } catch {
    return null;
  }

  const servers = parsed.mcpServers ?? {};

  for (const key of CHAT_SERVER_KEY_HINTS) {
    const entry = servers[key];
    if (!entry) continue;
    const handle = extractHandle(entry.args);
    if (handle) return { serverKey: key, handle, sourcePath: path };
  }

  for (const [key, entry] of Object.entries(servers)) {
    if (CHAT_SERVER_KEY_HINTS.includes(key)) continue;
    const handle = extractHandle(entry?.args);
    if (handle) return { serverKey: key, handle, sourcePath: path };
  }

  return null;
}
