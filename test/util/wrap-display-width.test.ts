import { test } from 'node:test';
import assert from 'node:assert/strict';
import stringWidth from 'string-width';
import { wrapBody, wrappedRowCount } from '../../src/util/wrap.js';

/**
 * 🛑 THE CJK ONES ARE NOW GUARANTEES. THE TABLE-ROW ONE IS STILL A DEFECT.
 *
 * `wrapLine` compared and sliced by UTF-16 code units at every step, so CJK
 * text drew at double its budget. Four partial repairs were measured and NONE
 * moved the number off 80 — every site had to change together, and the slice
 * had to iterate by CODE POINT so a surrogate pair was never cut in half.
 *
 * ⚠️ THE TABLE-ROW CASE IS DELIBERATE AND STAYS. A `|…|` row goes to the
 * Markdown tokenizer whole, because wrapping it breaks the pipe count. If that
 * test fails, the design changed — fix the README in the same commit, not this.
 */

const BUDGET = 40;

test('🚨 CJK text now fits the budget, measured in DISPLAY columns', () => {
  const body = '你好'.repeat(30);

  // The premise, so a future string-width change cannot make this vacuous.
  assert.equal(stringWidth('你好'), 4, 'two CJK glyphs occupy four columns');
  assert.equal('你好'.length, 2, 'and two code units — the gap this fix closes');

  const widest = Math.max(...wrapBody(body, BUDGET).split('\n').map((l) => stringWidth(l)));

  assert.equal(widest, BUDGET, 'it used to be 80');
});

/**
 * 🛑 THE CASE WHERE CODE UNITS FIT AND DISPLAY WIDTH DOES NOT.
 *
 * `'你'.repeat(30)` is 30 code units against a 40-column budget, so every
 * `.length` comparison says "fits" while it actually draws 60 columns. Two
 * mutants SURVIVED until this fixture existed — reverting the early return and
 * reverting the token-width test both stayed green on the other cases, because
 * those use 60 code units and fail the `.length` test for the wrong reason.
 */
test('🚨 a line whose CODE UNITS fit but whose columns do not is still wrapped', () => {
  const body = '你'.repeat(30);

  assert.ok(body.length < BUDGET, `premise: ${body.length} code units is under ${BUDGET}`);
  assert.ok(stringWidth(body) > BUDGET, `premise: ${stringWidth(body)} columns is over`);

  const lines = wrapBody(body, BUDGET).split('\n');

  assert.ok(Math.max(...lines.map((l) => stringWidth(l))) <= BUDGET);
  assert.ok(lines.length > 1, 'it must have wrapped at all');
});

/**
 * 🛑 THE WHITESPACE PATH, WHICH THE SINGLE-TOKEN TEST ABOVE NEVER REACHES.
 *
 * `'你好'.repeat(30)` has no spaces, so it goes down the hard-break branch.
 * Reverting the `cur + part` comparison to `.length` left that test GREEN —
 * a surviving mutant, and therefore a hole. Wide words separated by spaces
 * accumulate through the other branch.
 */
test('🚨 wide WORDS separated by spaces also fit, not just one long token', () => {
  const body = 'hello 你好世界 world 日本語テキスト here'.repeat(4);

  const lines = wrapBody(body, BUDGET).split('\n');
  const widest = Math.max(...lines.map((l) => stringWidth(l)));

  assert.ok(body.includes(' '), 'the fixture must exercise the whitespace branch');
  assert.ok(widest <= BUDGET, `widest line was ${widest}, budget ${BUDGET}`);
  assert.ok(lines.length > 1, 'and it must actually have wrapped');
});

/** Emoji were incidentally fine before. They must stay fine AND stay intact. */
test('🚨 an emoji run fits, and no surrogate pair is cut in half', () => {
  const body = '🚨'.repeat(30);

  const lines = wrapBody(body, BUDGET).split('\n');

  assert.ok(Math.max(...lines.map((l) => stringWidth(l))) <= BUDGET);
  assert.equal(lines.join(''), body, 'every code point survives the wrap');
});

/**
 * 🛑 ONE GLYPH WIDER THAN THE WHOLE BUDGET CANNOT BE SPLIT, so it overruns by
 * design. Without that guard the hard-break loop never terminates.
 */
test('🚨 a glyph wider than the budget emits alone instead of hanging', () => {
  const wrapped = wrapBody('你好', 1);

  assert.deepEqual(wrapped.split('\n'), ['你', '好']);
  assert.equal(stringWidth('你'), 2, 'each overruns the 1-column budget, by design');
});

/** The control: ASCII is wrapped correctly, so the defect is the WIDTH, not the wrap. */
test('🚨 ASCII still wraps correctly, so the common case did not regress', () => {
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
