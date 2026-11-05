import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CSS, block } from '../support/theme-tokens.js';
// @ts-expect-error — plain JS module, no types, same as the other logic tests.
import { JUMP_URGENCY_MS } from '../../web/assets/logic.js';

/**
 * 🛑 THE LEVEL COUNT LIVES IN TWO FILES AND NOTHING TIED THEM TOGETHER.
 *
 * `jumpUrgency` caps at `JUMP_URGENCY_MS.length`. The stylesheet has one
 * `[data-urgency='N']` rule per level. Add a fourth threshold and the element
 * gets `data-urgency="4"`, which matches no rule — so the LOUDEST level
 * renders identically to resting, and the feature fails in the direction
 * nobody looks.
 *
 * Measured by claude1 on PR 122, who injected the element and read the
 * computed style: level 4 came back `border rgb(223,227,235)`, one shadow
 * layer, byte-for-byte the resting state.
 */

/** Every level the stylesheet has a rule for, ascending. */
function styledLevels(): number[] {
  const found = [...CSS.matchAll(/\.jump-newest\[data-urgency='(\d+)'\]/g)].map((m) => Number(m[1]));

  return [...new Set(found)].sort((a, b) => a - b);
}

test('🛑 every level jumpUrgency can produce has a rule in the stylesheet', () => {
  const styled = styledLevels();
  const reachable = Array.from({ length: JUMP_URGENCY_MS.length }, (_, i) => i + 1);

  // The denominator first: a regex that stops matching must fail here rather
  // than report that zero levels are missing.
  assert.ok(styled.length > 0, 'found no [data-urgency] rules at all; the selector shape changed');

  const unstyled = reachable.filter((n) => !styled.includes(n));

  assert.deepEqual(
    unstyled,
    [],
    `jumpUrgency reaches ${reachable.join(', ')} but the stylesheet only styles ${styled.join(', ')}`,
  );
});

test('⚠️ and no rule styles a level jumpUrgency can never produce', () => {
  // The other direction is dead CSS rather than a silent failure, but it is
  // the tell that the two counts drifted.
  const orphans = styledLevels().filter((n) => n > JUMP_URGENCY_MS.length || n < 1);

  assert.deepEqual(orphans, [], `these levels are styled but unreachable: ${orphans.join(', ')}`);
});

test('🛑 the cap is the LOUDEST rule, not merely the last one', () => {
  // Level 2 is already the full accent, so the cap has to add something the
  // border alone cannot. If it ever stops adding a layer, the top two levels
  // look identical and the escalation silently ends one step early.
  const cap = block(`.jump-newest[data-urgency='${JUMP_URGENCY_MS.length}']`);

  assert.match(cap, /box-shadow:/, 'the cap must add a ring; the border is already at full accent');
});

test('the resting pill carries NO data-urgency rule of its own', () => {
  // `data-urgency="0"` must never be written — app.js removes the attribute
  // instead, so a rule for 0 would be unreachable and misleading.
  assert.equal(CSS.includes("[data-urgency='0']"), false);
});
