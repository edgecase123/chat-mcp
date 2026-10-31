import type { RateLimitSnapshot, WindowState } from '../rate-limit.js';
import type { Denial } from '../denial.js';

/**
 * Claude Code's event WORDING and SHAPES. Nothing else may import this.
 *
 * 🛑 BOTH PARSERS BELOW USED TO LIVE IN GENERIC FILES — one in `rate-limit.ts`
 * beside the driver-agnostic gate, one in `denial.ts` beside the semantic
 * type. A Cursor driver would have had to import Claude-named functions or
 * duplicate them. Moved on lee's instruction, 2026-10-31: *"this should also
 * work with cursor and that abstraction is probably necessary in this logic"*.
 */

/** Pull a snapshot out of a raw stream-json event, or null if it is not one. */
export function parseClaudeRateLimit(event: Record<string, unknown>): RateLimitSnapshot | null {
  if (event.type !== 'rate_limit_event') return null;

  const info = event.rate_limit_info as Record<string, unknown> | undefined;

  if (!info || typeof info !== 'object') return null;

  const raw = (info.unifiedWindows ?? {}) as Record<string, { utilization?: unknown; resetsAt?: unknown }>;
  const windows: Record<string, WindowState> = {};

  for (const [name, w] of Object.entries(raw)) {
    if (typeof w?.utilization === 'number') {
      windows[name] = {
        utilization: w.utilization,
        resetsAt: typeof w.resetsAt === 'number' ? w.resetsAt : 0,
      };
    }
  }

  return {
    status: typeof info.status === 'string' ? info.status : 'unknown',
    // Absent means we do not know, and we must not assume overage exists.
    overageAvailable: info.overageStatus === 'allowed',
    windows,
    observedAt: Date.now(),
  };
}


/**
 * The sentence every Claude Code denial opens with.
 *
 * 🛑 A CONTRACT WITH A PROGRAM WE DO NOT CONTROL. If the CLI rewords it, the
 * relay stops firing and a supervised agent looks like it is quietly giving
 * up. Naming it here is what makes that failure findable.
 */
export const DENIAL_PREFIX = 'Permission for this tool use was denied.';

/** What the CLI says needed approval, e.g. `rm in '/path/to/file'`. */
const REQUEST_CLAUSE = /What required approval:\s*(.+?)\s+was blocked\./;

/** Pull the text out of a `tool_result` part, whether string or parts array. */
function contentText(content: unknown): string | null {
  if (typeof content === 'string') return content;

  if (Array.isArray(content)) {
    const joined = content
      .map((p) => (p && typeof p === 'object' && 'text' in p ? String((p as { text: unknown }).text) : ''))
      .join('');

    return joined.length > 0 ? joined : null;
  }

  return null;
}

/**
 * The denial in this event, or null.
 *
 * ⚠️ ONLY a `user` event's `tool_result` counts. The model TALKING about a
 * denial — in assistant text, or in the final `result` — is not a denial, and
 * treating it as one would relay noise to lee and hold a turn that was never
 * blocked.
 */
export function denialFromClaude(event: Record<string, unknown> | null | undefined): Denial | null {
  if (!event || event.type !== 'user') return null;

  const message = event.message as { content?: unknown } | undefined;
  const parts = message?.content;

  if (!Array.isArray(parts)) return null;

  for (const part of parts) {
    if (!part || typeof part !== 'object') continue;
    if ((part as { type?: unknown }).type !== 'tool_result') continue;

    const text = contentText((part as { content?: unknown }).content);
    if (!text || !text.startsWith(DENIAL_PREFIX)) continue;

    return { requested: REQUEST_CLAUSE.exec(text)?.[1] ?? null, raw: text };
  }

  return null;
}
