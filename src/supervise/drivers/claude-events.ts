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
/**
 * The last tool call seen, by id, so a denial can name the EXACT invocation.
 *
 * ⚠️ MODULE STATE, bounded. Only the ids still awaiting a result are kept,
 * and each is deleted the moment it is paired — a long session must not grow
 * a map of every call it ever made.
 */
const pendingCalls = new Map<string, { tool: string; invocation: string }>();

/** Record a tool call so a later denial can be paired to it. */
export function rememberClaudeToolUse(event: Record<string, unknown>): void {
  if (event.type !== 'assistant') return;

  const parts = (event.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(parts)) return;

  for (const part of parts) {
    if (!part || typeof part !== 'object') continue;
    if ((part as { type?: unknown }).type !== 'tool_use') continue;

    const { id, name, input } = part as { id?: string; name?: string; input?: unknown };
    if (!id || !name) continue;

    // Bash carries `command`; other tools are identified by name alone.
    const command =
      input && typeof input === 'object' && typeof (input as { command?: unknown }).command === 'string'
        ? (input as { command: string }).command
        : null;

    pendingCalls.set(id, { tool: name, invocation: command ?? name });
  }
}

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

    const id = (part as { tool_use_id?: unknown }).tool_use_id;
    const call = typeof id === 'string' ? pendingCalls.get(id) : undefined;

    // Paired and consumed: the map holds only calls still awaiting a result.
    if (typeof id === 'string') pendingCalls.delete(id);

    return {
      requested: REQUEST_CLAUSE.exec(text)?.[1] ?? null,
      raw: text,
      tool: call?.tool ?? null,
      invocation: call?.invocation ?? null,
    };
  }

  return null;
}

/**
 * How long a logged line of child output may be before it is cut.
 *
 * 🛑 NOT 80. The `→ child:` side cut at 80 with newlines stripped, and an
 * alert banner plus `[chat-mcp] <from>:` is longer than that on its own — so
 * a reviewer read a present message body as missing and diagnosed the wrong
 * half of the arc for a session.
 */
export const LOG_EXCERPT_LIMIT = 200;

/** One line of `text`, safe to put in a log, with any cut declared. */
export function excerptForLog(text: string): string {
  const flat = text.replace(/\s*\n+\s*/g, ' ⏎ ').trim();

  if (flat.length <= LOG_EXCERPT_LIMIT) return flat;

  // ⚠️ `flat.length`, NOT `text.length`. The slice is taken from `flat`, and
  // collapsing newlines to ` ⏎ ` changes the length in either direction — a
  // wake prompt is `[chat-mcp] <from>:\n\n<body>`, so `flat` is the LONGER of
  // the two there. Reporting the other one hands the reader a wrong
  // remainder. Found by claude2 on PR 209.
  return `${flat.slice(0, LOG_EXCERPT_LIMIT)}… (${flat.length} chars)`;
}

/**
 * What the child produced on this event, as one log line, or `undefined` for
 * an event that carries no output.
 *
 * 🛑 THE SUPERVISOR WAS DEAF TO ITS OWN CHILD. It logged every prompt in and
 * nothing back, so "the agent answered somewhere we cannot see" and "the
 * agent said nothing at all" produced identical logs. `AgentChild.onEvent`
 * already existed and `index.ts` never called it.
 *
 * ⚠️ TOOL CALLS ARE NAMED BUT THEIR INPUT IS NOT LOGGED. A `mcp__chat__send`
 * input is the message body, and a `Bash` input is a command line — neither
 * belongs in a log that an operator pastes into a room.
 */
export function describeChildOutput(event: Record<string, unknown>): string | undefined {
  if (event.type !== 'assistant') return undefined;

  const message = event.message as { content?: unknown } | undefined;
  const content = message?.content;

  if (!Array.isArray(content)) return undefined;

  const parts: string[] = [];

  for (const block of content) {
    const b = block as { type?: unknown; text?: unknown; name?: unknown };

    if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
      parts.push(excerptForLog(b.text));
    } else if (b.type === 'tool_use' && typeof b.name === 'string') {
      parts.push(`[tool] ${b.name}`);
    }
  }

  if (parts.length === 0) return undefined;

  return parts.join(' | ');
}

/**
 * The outcome of a finished turn, as one log line.
 *
 * 🛑 WITHOUT THIS A DEAD TURN PROVES ITSELF BY ABSENCE. `describeChildOutput`
 * covers `assistant` events only, and a turn that errors or is rejected emits
 * `result` and no assistant event at all — so the failure we were chasing
 * logged exactly what it logged before the child feed was wired up.
 *
 * An absence cannot tell "the agent said nothing" apart from "the event feed
 * broke". This makes the outcome a positive statement. Raised by claude2 on
 * PR 209.
 */
export function describeTurnResult(event: Record<string, unknown>): string | undefined {
  if (event.type !== 'result') return undefined;

  const subtype = typeof event.subtype === 'string' ? event.subtype : 'unknown';
  const failed = event.is_error === true;

  return `subtype=${subtype} is_error=${failed}`;
}

/**
 * The token fields Claude Code reports per turn. Everything else is ignored.
 */
export interface ClaudeUsage {
  input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/**
 * How full the context window is, from one turn's usage.
 *
 * 🛑 `output_tokens` IS NOT IN THE SUM AND MUST NOT BE ADDED. Measured on a
 * live Opus 5 session: this sum gave 118,783 against `/context`'s own 118.8k,
 * while adding output gave 119,360 and would have printed 119.4k. Output
 * reaches the window only as the next turn's input, where this sum already
 * counts it. #213 proposed adding it; `claude-context.test.ts` pins it out.
 */
export function usedFromUsage(usage: ClaudeUsage): number {
  return (
    (usage.input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0)
  );
}

/**
 * The live context size this event reports, or null if it reports none.
 *
 * 🛑 `assistant` ONLY, THOUGH `result` CARRIES `usage` TOO. The gauge is
 * last-write-wins, so reading both is redundant rather than double-counted —
 * but `assistant` is the entry the host hook reads out of the transcript, so
 * restricting to it is what makes host and container agree by construction.
 */
export function parseClaudeContextUsed(event: Record<string, unknown>): number | null {
  if (event.type !== 'assistant') return null;

  const usage = (event.message as { usage?: ClaudeUsage } | undefined)?.usage;

  if (!usage || typeof usage !== 'object') return null;

  return usedFromUsage(usage);
}

/**
 * The model this session runs, from the session-opening event, or null.
 *
 * ⚠️ THE EVENT IS `type: "system"` WITH `subtype: "init"`. Everyone calls it
 * "the init event", and `type: "init"` does not exist — a parser written from
 * the name alone matches nothing and the gauge silently never gets a window.
 */
export function parseClaudeModel(event: Record<string, unknown>): string | null {
  if (event.type !== 'system' || event.subtype !== 'init') return null;

  return typeof event.model === 'string' && event.model.length > 0 ? event.model : null;
}

/**
 * What a supervisor uses as the window when the model id is not mapped.
 *
 * ⚠️ EVERY CURRENT MODEL BUT HAIKU IS A MEGATOKEN, so this is the sane guess —
 * and it is still a guess, which is why the caller logs the id it fell back on.
 */
export const FALLBACK_CONTEXT_WINDOW = 1_000_000;

/**
 * Context-window size per model id, or null when the id is not mapped.
 *
 * 🛑 EXACT MATCH, AND null RATHER THAN A FALLBACK. A prefix rule would quietly
 * absorb the next model family, and returning the fallback here would make an
 * unmapped id indistinguishable from a mapped megatoken one — so nothing would
 * ever be logged and a wrong denominator would never surface.
 */
const CONTEXT_WINDOWS: Readonly<Record<string, number>> = {
  'claude-fable-5-1': 1_000_000,
  'claude-fable-5': 1_000_000,
  'claude-mythos-5-1': 1_000_000,
  'claude-opus-5': 1_000_000,
  'claude-opus-4-8': 1_000_000,
  'claude-opus-4-7': 1_000_000,
  'claude-opus-4-6': 1_000_000,
  'claude-sonnet-5': 1_000_000,
  'claude-sonnet-4-6': 1_000_000,
  'claude-haiku-4-5': 200_000,
};

export function contextWindowForModel(model: string): number | null {
  return CONTEXT_WINDOWS[model] ?? null;
}
