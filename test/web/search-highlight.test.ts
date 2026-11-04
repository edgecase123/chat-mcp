import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error — plain JS module, no types, same as the other logic tests.
import { matchRanges, messageMatchesSearch, searchableText, searchFilterEmpty } from '../../web/assets/logic.js';

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

/**
 * 🛑 A MARKDOWN LINK'S URL IS NOT IN THE RENDERED TEXT.
 *
 * `[PR 118](https://github.com/edgecase123/chat-mcp/pull/118)` renders as an
 * `<a>` whose href holds the URL and whose text holds only "PR 118". Matching
 * `textContent` alone made every PR reference in `#leagues` unfindable by its
 * URL. Found by claude1 reviewing PR 118.
 *
 * `searchableText` is given the href list because the DOM parse belongs to the
 * caller — these tests run under plain `node --test`, with no document.
 */

test('🛑 a markdown link URL is findable, though only its LABEL is on screen', () => {
  const text = searchableText('decided in PR 118', ['https://github.com/edgecase123/chat-mcp/pull/118']);

  assert.ok(messageMatchesSearch(text, 'chat-mcp/pull/118'));
  assert.ok(messageMatchesSearch(text, 'github.com'));
  // The label still matches, which is the behaviour the href must not displace.
  assert.ok(messageMatchesSearch(text, 'PR 118'));
});

test('a bare URL is NOT doubled — it is already its own label', () => {
  const url = 'https://github.com/edgecase123/chat-mcp/pull/118';

  assert.equal(searchableText(`see ${url} here`, [url]), `see ${url} here`);
});

test('the same href twice appends it once', () => {
  const url = 'https://example.test/a';

  assert.equal(searchableText('one two', [url, url]), `one two\n${url}`);
});

test('no links means the string is the rendered text, byte for byte', () => {
  assert.equal(searchableText('plain body', []), 'plain body');
  assert.equal(searchableText('plain body'), 'plain body');
});

test('an empty or non-string href is skipped rather than appended blank', () => {
  // @ts-expect-error — deliberately wrong types, as a hostile DOM could give.
  assert.equal(searchableText('body', ['', null, undefined]), 'body');
});

test('🛑 no term can straddle the join, so the appended URL invents no phrase', () => {
  // "here" ends the text and "https" starts the href. A space join would make
  // "here https" matchable, and those words are not contiguous on screen.
  const text = searchableText('ends here', ['https://example.test/x']);

  assert.equal(messageMatchesSearch(text, 'here https'), false);
  assert.ok(messageMatchesSearch(text, 'example.test'));
});

/**
 * ⚠️ NEGATIVE CONTROL for the whole feature: without the href the URL search
 * finds nothing. This is the state PR 118 shipped at `402ceea` and it is the
 * regression this file now pins.
 */
test('⚠️ control — rendered text alone cannot find the URL', () => {
  assert.equal(messageMatchesSearch('decided in PR 118', 'chat-mcp/pull/118'), false);
});

test('🛑 a neutered link contributes NOTHING — `#` is not a destination', () => {
  // `safeUrl` renders a `javascript:` target as `href="#"`. Appending that made
  // the single-character term "#" match every message holding a dead link.
  const text = searchableText('careful with this link', ['#']);

  assert.equal(text, 'careful with this link');
  assert.equal(messageMatchesSearch(text, '#'), false);
});

test('a real fragment or relative href is still appended', () => {
  // `safeUrl` passes `/`, `#` and `?` prefixes through, so these are genuine
  // destinations and only the bare `#` is the dead one.
  assert.equal(searchableText('see the gate', ['#gate-section']), 'see the gate\n#gate-section');
  assert.equal(searchableText('see the gate', ['/rooms/gate']), 'see the gate\n/rooms/gate');
});
