import { realpathSync } from 'node:fs';
import { basename, dirname } from 'node:path';

/**
 * The semantic shape of "the child was refused a tool".
 *
 * 🛑 THE TYPE IS HERE; THE WORDING IS IN THE DRIVER. Claude Code reports a
 * denial as a `tool_result` opening with a fixed English sentence. Another CLI
 * will not. `drivers/claude-events.ts` owns that string, so a Cursor driver
 * maps its own signal onto this type and nothing above the driver changes.
 *
 * Moved out of this file on lee's instruction, 2026-10-31.
 */
export interface Denial {
  /**
   * What needed approval, or null when it could not be parsed.
   *
   * 🛑 NULL, NEVER A GUESS. This string is what gets relayed to lee and then
   * allowlisted, so a guess would ask lee to approve something the child never
   * asked for.
   */
  readonly requested: string | null;

  /** The whole message, so a relay can quote the reason instead of summarising. */
  readonly raw: string;

  /**
   * The tool that was refused, e.g. `Bash`.
   *
   * 🛑 FROM THE TOOL CALL, NOT THE PROSE. `requested` is what a human reads;
   * this is what the allowlist needs. They are different languages, and
   * feeding the prose into `--allowedTools` grants nothing — measured live:
   * lee approved `rm in '/path/README.md'`, the child was denied again, and
   * a second card appeared.
   */
  readonly tool: string | null;

  /** The exact invocation, e.g. the full Bash command line. */
  readonly invocation: string | null;
}

/**
 * The allowlist entry that grants exactly this invocation and nothing else.
 *
 * 🛑 EXACT, NOT A PREFIX — lee's decision, 2026-10-31. `Bash(rm:*)` would
 * grant every `rm` for the rest of the session, which is broader than the
 * card said. Measured: an exact entry is honoured, with a control proving
 * the allowlist is what decided.
 */
export function grantFor(denial: Denial): string | null {
  if (!denial.tool || !denial.invocation) return null;

  return entryFor(denial.tool, canonicalisePaths(denial.invocation));
}

/**
 * One allowlist entry for a tool and the thing it was asked to do.
 *
 * 🚨 A TOOL WITH NO RULE CONTENT TAKES ITS BARE NAME. Measured on run 12:
 * `mcp__chat__set_status(mcp__chat__set_status)` went into --allowedTools and
 * the child asked for the same permission again, so approvals 23 and 24 came
 * out byte-identical. The parenthesised form is for a Bash command or an Edit
 * glob; an MCP tool has nothing to put in the parentheses.
 */
function entryFor(tool: string, content: string): string {
  return content === tool ? tool : `${tool}(${content})`;
}

/**
 * Every spelling of the grant that means the same thing.
 *
 * 🚨 ONE SPELLING IS NOT ENOUGH, AND THE FIRST LIVE PROOF WAS MY OWN FIX
 * BREAKING IT. On macOS `/var` is a symlink to `/private/var`. The child's
 * first attempt used `/var/…`; the re-dispatch prompt named the REALPATH,
 * because `resolveCwd` resolves it; so the retry used `/private/var/…` and
 * did not match the grant lee had just approved. Two strings, same file,
 * another card.
 *
 * ⚠️ This is the re-issue risk that was flagged when exact matching was
 * chosen over a prefix pattern. It bit on the first attempt, by a route
 * neither of us predicted — not a reworded command, a normalised path.
 *
 * Both forms are allowlisted because they denote the same file. That is
 * wider than one string and NOT wider than the file lee approved.
 */
export function grantVariants(denial: Denial): string[] {
  if (!denial.tool || !denial.invocation) return [];

  const tool = denial.tool;
  const whole = denial.invocation;
  const lead = leadingSegment(whole);

  const forms = new Set([whole, canonicalisePaths(whole), lead, canonicalisePaths(lead)]);

  return [...forms].map((form) => entryFor(tool, form));
}

/**
 * The first command of a compound line, e.g. `rm x && ls y` -> `rm x`.
 *
 * Rejected: granting only the whole line. The child rewrites its trailing
 * commands between attempts, so an exact grant never covers the retry.
 */
function leadingSegment(invocation: string): string {
  return invocation.split(/\s*(?:&&|\|\||;|\|)\s*/)[0]!.trim();
}

/**
 * The bare command inside an allowlist entry, e.g. `Bash(rm x)` -> `rm x`.
 *
 * 🛑 THE RE-DISPATCH PROMPT NEEDS THE COMMAND, NOT THE ENTRY, AND NOT THE
 * PROSE. Measured on run 10: the child was told to attempt `touch in
 * '<path>'` — the sentence a human reads — so it typed something no grant
 * covered and was re-blocked while the allowlist was perfectly correct.
 */
export function commandFromGrant(grant: string): string | null {
  const entry = grant.trim();
  if (entry.length === 0) return null;

  const match = /^[A-Za-z_]\w*\((.*)\)$/s.exec(entry);

  // 🛑 A BARE ENTRY IS ALREADY THE ANSWER. An MCP tool grants its own name
  // with no parentheses, and returning null here made the prompt fall back
  // to the prose — which is null for those denials, so it threw.
  return match === null ? entry : match[1];
}

/**
 * Rewrite absolute paths in a command to their resolved form.
 *
 * A path with no existing ancestor is left alone — nothing can be resolved
 * about it.
 */
function canonicalisePaths(invocation: string): string {
  return invocation.replace(/(^|\s)(\/[^\s'"]+)/g, (whole, lead: string, path: string) => {
    const resolved = resolveDeepest(path);

    return resolved === null ? whole : `${lead}${resolved}`;
  });
}

/**
 * The path with its longest EXISTING ancestor resolved, tail re-appended.
 *
 * 🚨 RESOLVING ONLY WHAT EXISTS PUT TWO SPELLINGS OF ONE DIRECTORY INTO ONE
 * GRANT. Measured on run 9: `mkdir -p <dir> && touch <dir>/new.txt` became
 * `mkdir -p /private/var/…/work && touch /var/…/work/new.txt`, because the
 * directory resolved and the file it was about to create could not. That
 * string matches nothing the child could type, so the approval re-looped.
 *
 * A leaf that does not exist yet is the NORMAL case for a creating command,
 * so the mixed spelling was guaranteed rather than unlucky.
 */
function resolveDeepest(path: string): string | null {
  const tail: string[] = [];
  let head = path;

  while (head !== '/' && head !== '.') {
    try {
      return [realpathSync(head), ...tail].join('/');
    } catch {
      tail.unshift(basename(head));
      head = dirname(head);
    }
  }

  return null;
}
