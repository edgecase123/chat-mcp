import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error — plain JS module, no types, same as the other logic tests.
import { matchRanges, messageMatchesSearch, searchFilterEmpty } from '../../web/assets/logic.js';

/**
 * 🛑 HIGHLIGHTING IS WHERE A SEARCH FEATURE GETS DANGEROUS.
 *
 * Marking up the text means either injecting `<mark>` into markdown source,
 * which corrupts a code span or a link, or into rendered HTML, where it can
 * land inside a tag and is an injection hazard. So this module returns
 * OFFSETS and the caller wraps text nodes, which can do neither.
 *
 * 🛑 AND THE RULE MUST MATCH THE SQL. `likePattern` escapes `%` and `_` so the
 * bus finds literal text; a regex-based highlighter would treat them as
 * patterns and mark the wrong characters in a row that matched correctly.
 */

test('🛑 a term with % is matched LITERALLY, as the SQL side matched it', () => {
  assert.deepEqual(matchRanges('the gauge read 100% twice', '100%'), [{ start: 15, end: 19 }]);
});

test('🛑 a term with regex metacharacters marks itself, not a pattern', () => {
  // `.` would match any character, `(` would throw, `*` would be a quantifier.
  assert.deepEqual(matchRanges('reset-and-test.sh ran', 'test.sh'), [{ start: 10, end: 17 }]);
  assert.deepEqual(matchRanges('a+b and aXb', 'a+b'), [{ start: 0, end: 3 }]);
  assert.deepEqual(matchRanges('see (note) here', '(note)'), [{ start: 4, end: 10 }]);
  assert.deepEqual(matchRanges('context_used column', 'context_used'), [{ start: 0, end: 12 }]);
});

test('the match is case-insensitive, like LIKE', () => {
  assert.deepEqual(matchRanges('CLAIMING the gate', 'claiming'), [{ start: 0, end: 8 }]);
  assert.deepEqual(matchRanges('claiming the gate', 'CLAIMING'), [{ start: 0, end: 8 }]);
});

test('every occurrence is returned, in order', () => {
  assert.deepEqual(matchRanges('gate, then gate again', 'gate'), [
    { start: 0, end: 4 },
    { start: 11, end: 15 },
  ]);
});

test('🛑 ranges never OVERLAP, or the markup nests around the same characters', () => {
  // Advancing by one instead of by the match length produces three ranges
  // here, and three <mark> elements wrapping each other.
  assert.deepEqual(matchRanges('aaaa', 'aa'), [
    { start: 0, end: 2 },
    { start: 2, end: 4 },
  ]);
});

test('a blank or whitespace term matches nothing, rather than everything', () => {
  // A zero-length needle would make indexOf return 0 forever.
  assert.deepEqual(matchRanges('anything', ''), []);
  assert.deepEqual(matchRanges('anything', '   '), []);
  assert.deepEqual(matchRanges('anything', undefined), []);
});

test('a term absent from the text returns nothing', () => {
  assert.deepEqual(matchRanges('the gate is free', 'zzzz'), []);
});

test('the term is trimmed, so a trailing space does not kill every match', () => {
  assert.deepEqual(matchRanges('the gate', ' gate '), [{ start: 4, end: 8 }]);
});

test('🛑 the filter and the highlighter agree, on every case above', () => {
  // A message kept by the filter that the highlighter finds nothing in renders
  // a hit with no visible reason, which reads as a broken search.
  for (const [body, term] of [
    ['the gauge read 100%', '100%'],
    ['CLAIMING the gate', 'claiming'],
    ['context_used column', 'context_used'],
    ['reset-and-test.sh', 'test.sh'],
  ] as const) {
    assert.equal(messageMatchesSearch(body, term), true, `${term} should match ${body}`);
    assert.ok(matchRanges(body, term).length > 0);
  }

  for (const [body, term] of [['the gate', 'zzz'], ['the gate', ''], ['', 'gate']] as const) {
    assert.equal(messageMatchesSearch(body, term), false);
    assert.deepEqual(matchRanges(body, term), []);
  }
});

test('the filter survives a missing body', () => {
  assert.equal(messageMatchesSearch(undefined, 'gate'), false);
  assert.equal(messageMatchesSearch(null, 'gate'), false);
});

test('🛑 an empty filtered view SAYS what it searched and how much it saw', () => {
  // "nothing here" would not tell the operator whether the term is absent or
  // whether the pane simply has not loaded that far back.
  const s = searchFilterEmpty('gate', 12);

  assert.match(s, /gate/);
  assert.match(s, /12 loaded messages/);
  assert.match(searchFilterEmpty('gate', 1), /1 loaded message\b/, 'singular, because 1 messages reads as a bug');
});
