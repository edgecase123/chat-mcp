import assert from "node:assert/strict";

/**
 * Drop the handoff pointer out of a recorded `sent` array and release its turn,
 * so every index into that array names an INBOUND prompt.
 *
 * 🛑 THE POINTER IS DISPATCHED AT SPAWN, BEFORE ANY BUS MESSAGE, and the queue
 * runs one turn at a time. A test that neither drops it nor releases it reads
 * the pointer where it means to read a prompt, and the message it delivered is
 * still held behind the pointer's open turn.
 *
 * 🛑 IT ASSERTS WHAT IT DROPS. A bare `shift()` would eat the operator's own
 * first prompt the day the pointer stops being offered, and every assertion
 * built on the index would still pass. One already did: `/hi/` matches
 * "t(hi)s is a fresh start" inside the pointer's own text, so a mount-banner
 * test reported a clean banner on a prompt it never read.
 *
 * ⚠️ IT TAKES THE ARRAY AND THE CHILD SEPARATELY, because the fakes in this
 * repo differ: some share one `sent` across every child, some keep one each.
 */
export function releasePointerTurn(
  sent: string[],
  child: { finishTurn: () => void } | undefined,
): void {
  const first = sent.shift() ?? "";

  assert.match(
    first,
    /HANDOFF\.md/,
    `the first send was not the handoff pointer:\n${first}`,
  );

  child?.finishTurn();
}
