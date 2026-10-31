/**
 * Recognising that the child was refused a tool.
 *
 * 🛑 THE SIGNAL IS STRUCTURED AND MUST NOT BE GUESSED FROM PROSE. The CLI
 * returns a `tool_result` whose content opens with a fixed sentence and then
 * names what needed approval. Captured verbatim on 2026-10-31; the fixture in
 * `denial.test.ts` is the real string, not a paraphrase.
 *
 * 🛑 THE TEXT ALSO TELLS THE CHILD NOT TO RETRY FOR THE REST OF THE SESSION.
 * That is why a vague re-dispatch prompt fails — the child is obeying an
 * instruction, not being stubborn. Two live runs read as model intransigence
 * before anyone read this string. See `redispatch.ts`.
 */

/**
 * The sentence every denial opens with.
 *
 * 🛑 A CONTRACT WITH A PROGRAM WE DO NOT CONTROL. If the CLI rewords it, the
 * relay stops firing and a supervised agent looks like it is quietly giving
 * up. Naming it here is what makes that failure findable.
 */
export const DENIAL_PREFIX = 'Permission for this tool use was denied.';

/** What the CLI says needed approval, e.g. `rm in '/path/to/file'`. */
const REQUEST_CLAUSE = /What required approval:\s*(.+?)\s+was blocked\./;

export interface Denial {
  /**
   * What needed approval, or null when the clause could not be parsed.
   *
   * 🛑 NULL, NEVER A GUESS. This string is what gets relayed to lee and then
   * allowlisted. A guess would ask lee to approve something the child never
   * asked for.
   */
  readonly requested: string | null;

  /** The whole message, so a relay can quote the reason instead of summarising. */
  readonly raw: string;
}

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
export function denialFrom(event: Record<string, unknown> | null | undefined): Denial | null {
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
