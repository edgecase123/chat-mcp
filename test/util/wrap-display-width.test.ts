import { test } from 'node:test';
import assert from 'node:assert/strict';
import stringWidth from 'string-width';
import { wrapBody, wrappedRowCount } from '../../src/util/wrap.js';

/**
 * 🛑 THESE PIN TWO DEFECTS, NOT TWO GUARANTEES.
 *
 * The README's "fallback only" section states both as reasons the terminal UI
 * is less finished than the browser UI. An unpinned sentence about a mechanism
 * outlives the mechanism, so these exist to FAIL when either is fixed.
 *
 * ⚠️ IF ONE OF THESE FAILS, THE FIX IS NOT THE TEST. Update the README section
 * in the same change, then invert the assertion here. Raised by claude2 as the
 * reason the prose should not carry the claim alone.
 *
 * 🛑 THE CJK ONE IS PINNED AT THE OUTCOME, NOT AT A LINE, AND THAT IS
 * DELIBERATE. Four separate partial fixes were measured and NONE moved the
 * number off 80:
 *
 *   the early `line.length <= cols` return      still 80
 *   plus `part.length` and `remaining.length`   still 80
 *   plus a display-width-aware slice            still 80
 *
 * Every site counts code units, and whatever the loop does not emit lands in
 * the trailing `cur`, which is pushed unmeasured. So naming one line in the
 * README would send a fixer at a line whose repair changes nothing.
 */

const BUDGET = 40;

test('🚨 DEFECT: the wrap counts UTF-16 code units, so CJK draws at double its budget', () => {
  const body = '你好'.repeat(30);

  const widest = Math.max(...wrapBody(body, BUDGET).split('\n').map((l) => stringWidth(l)));

  // The premise, so a future string-width change cannot make this vacuous.
  assert.equal(stringWidth('你好'), 4, 'two CJK glyphs occupy four columns');
  assert.equal('你好'.length, 2, 'and two code units');

  assert.equal(widest, BUDGET * 2, 'still double — if this fails, the wrap was fixed; see the docblock');
});

/** The control: ASCII is wrapped correctly, so the defect is the WIDTH, not the wrap. */
test('🚨 ASCII of the same code-unit length wraps correctly', () => {
  const body = 'x'.repeat(120);

  const widest = Math.max(...wrapBody(body, BUDGET).split('\n').map((l) => stringWidth(l)));

  assert.equal(widest, BUDGET);
});

test('🚨 DEFECT: a markdown table row is left unwrapped and billed as one row', () => {
  const row = '| a very wide column header here | and another wide one | and a third |';
  assert.ok(stringWidth(row) > BUDGET, 'the fixture must actually exceed the budget');

  const wrapped = wrapBody(row, BUDGET);

  assert.equal(wrapped, row, 'returned verbatim — see src/util/wrap.ts, the table-row branch');
  assert.equal(wrappedRowCount(row, BUDGET), 1, 'one row reserved, however many it draws');
});

/** The control: the same text without the pipes IS wrapped. */
test('🚨 the same text without pipes is wrapped, so it is the table branch doing it', () => {
  const plain = 'a very wide column header here and another wide one and a third';

  const widest = Math.max(...wrapBody(plain, BUDGET).split('\n').map((l) => stringWidth(l)));

  assert.ok(widest <= BUDGET, `plain prose must fit, got ${widest}`);
  assert.ok(wrappedRowCount(plain, BUDGET) > 1, 'and must take more than one row');
});
