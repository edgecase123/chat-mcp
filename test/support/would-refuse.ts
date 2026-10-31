import { readFileSync } from 'node:fs';

/**
 * Would a real child refuse this, and with which captured words?
 *
 * 🛑 TEST INFRASTRUCTURE, NOT PRODUCTION. It models the CLI's permission
 * answer so the suite can fail on a grant the child could not have used. It
 * must never be imported from `src/`.
 *
 * 🛑 THE REFUSALS ARE REPLAYED, NOT WRITTEN. lee's ruling, 2026-10-31:
 * *"replay the captured refusal text"*. The reason is calibration — the
 * author's understanding of this CLI was wrong five separate times that day,
 * and a hand-written rule would have frozen each wrong belief into a passing
 * test.
 */
export interface Capture {
  readonly firstSeenApprovalId: number;
  readonly grant: string;
  readonly refusal: string;
}

const CORPUS: Capture[] = JSON.parse(
  readFileSync('test/fixtures/captured-refusals.json', 'utf8'),
);

/**
 * The capture whose words match this shape.
 *
 * ⚠️ IT THROWS WHEN THE CORPUS NO LONGER HOLDS THAT SHAPE. That is the
 * staleness signal lee's decision chose rather than solved: a replayed
 * capture can rot, and a silent fallback to a hand-written string would hide
 * exactly the rot the replay rule exists to prevent.
 */
function replay(shape: RegExp): Capture {
  const found = CORPUS.find((c) => shape.test(c.refusal));

  if (!found) {
    throw new Error(
      `no captured refusal matches ${shape}. The corpus has gone stale — ` +
        're-capture from ~/.chat-mcp/chat.db (approvals.reason) rather than writing one.',
    );
  }

  return found;
}

export function wouldRefuse(attempted: string, allowed: readonly string[]): Capture | null {
  const want = attempted.trim();

  // An empty command is what a null grant plus null prose produced.
  if (want.length === 0) return replay(/^This command requires approval/);

  // A bare tool name has no whitespace. `Tool(Tool)` in the list does NOT
  // grant it — measured on run 12, approvals 23 and 24 came out identical.
  if (!/\s/.test(want)) {
    return allowed.includes(want) ? null : replay(/haven't granted it yet/);
  }

  // `<verb> in '<path>'` is the sentence a human reads, not a command. The
  // prompt sent exactly this on run 10.
  if (/^\S+ in '/.test(want)) return replay(/was blocked/);

  return allowed.includes(`Bash(${want})`) ? null : replay(/^This command requires approval/);
}
