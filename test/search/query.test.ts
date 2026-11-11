import { test } from 'node:test';
import assert from 'node:assert/strict';
import { likePattern, parseSearch, snippet, MAX_LIMIT } from '../../src/search/query.js';

/**
 * 🛑 A WRONG SEARCH RETURNS RESULTS, SO IT LOOKS LIKE IT WORKED.
 *
 * `LIKE` treats `%` and `_` as wildcards. A query containing either silently
 * matches far more than the operator typed, and the only symptom is a longer
 * list. That is the failure this module exists to make impossible.
 *
 * 🛑 FTS5 WAS NOT AN OPTION. `node:sqlite` has no fts5 module — measured, and
 * recorded on #102. So the escaping below is the whole correctness story
 * rather than a stopgap.
 */

test('🛑 a percent in the query matches a LITERAL percent, not everything', () => {
  // Without the escape, searching "100%" returns every message on the bus and
  // reads as a very popular term.
  const p = likePattern('100%');

  assert.equal(p, '%100\\%%');
});

test('🛑 an underscore matches a LITERAL underscore, not any character', () => {
  // `claude_1` would otherwise match `claude1`, `claudeX1`, `claude-1`.
  assert.equal(likePattern('claude_1'), '%claude\\_1%');
});

test('a backslash is escaped FIRST, or the escape character escapes itself wrong', () => {
  // Escaping % and _ before \ would turn `a\%b` into `a\\%b`, where the
  // backslash escapes the backslash and the % goes back to being a wildcard.
  assert.equal(likePattern('a\\b'), '%a\\\\b%');
  assert.equal(likePattern('a\\%b'), '%a\\\\\\%b%');
});

test('ordinary text is wrapped and otherwise untouched', () => {
  assert.equal(likePattern('reset-and-test.sh'), '%reset-and-test.sh%');
  assert.equal(likePattern('CLAIMING'), '%CLAIMING%');
});

test('a query is trimmed, because a trailing space is not a search term', () => {
  assert.equal(likePattern('  gate  '), '%gate%');
});

test('a blank query is REFUSED rather than matching everything', () => {
  // `%%` matches every row. A blank search returning the whole transcript is
  // indistinguishable from a search that worked.
  assert.equal(parseSearch({ q: '' }).ok, false);
  assert.equal(parseSearch({ q: '   ' }).ok, false);
  assert.equal(parseSearch({ q: undefined }).ok, false);
});

test('a one-character query is allowed, and reported as broad', () => {
  const r = parseSearch({ q: 'a' });

  assert.equal(r.ok, true);
  assert.equal(r.ok && r.broad, true, 'the caller should be able to warn');
});

test('a normal query is not broad', () => {
  const r = parseSearch({ q: 'gate' });

  assert.equal(r.ok && r.broad, false);
});

test('the target scopes the search, and is optional', () => {
  const scoped = parseSearch({ q: 'gate', target: '#leagues' });
  assert.equal(scoped.ok && scoped.target, '#leagues');

  const unscoped = parseSearch({ q: 'gate' });
  assert.equal(unscoped.ok && unscoped.target, undefined);

  // A blank target is the same as none, not a search for the empty room.
  const blank = parseSearch({ q: 'gate', target: '  ' });
  assert.equal(blank.ok && blank.target, undefined);
});

test('🛑 the limit is CAPPED, so one search cannot return the whole transcript', () => {
  const byDefault = parseSearch({ q: 'a' });
  assert.equal(byDefault.ok && byDefault.limit, 50);

  const asked = parseSearch({ q: 'a', limit: 10 });
  assert.equal(asked.ok && asked.limit, 10);

  const over = parseSearch({ q: 'a', limit: 9999 });
  assert.equal(over.ok && over.limit, MAX_LIMIT);

  // Junk falls back rather than becoming zero, which would return nothing and
  // read as "no matches".
  const zero = parseSearch({ q: 'a', limit: 0 });
  assert.equal(zero.ok && zero.limit, 50);

  const negative = parseSearch({ q: 'a', limit: -5 });
  assert.equal(negative.ok && negative.limit, 50);

  const notANumber = parseSearch({ q: 'a', limit: Number.NaN });
  assert.equal(notANumber.ok && notANumber.limit, 50);
});

test('a snippet centres on the match rather than always taking the head', () => {
  const body = `${'x'.repeat(200)}NEEDLE${'y'.repeat(200)}`;
  const s = snippet(body, 'needle', 60);

  assert.ok(s.includes('NEEDLE'), 'the match has to be in the snippet it describes');
  assert.ok(s.length <= 60 + 6, `snippet is ${s.length} chars`);
});

test('a snippet marks where it cut, so a reader knows it is not the whole message', () => {
  const s = snippet(`${'x'.repeat(100)}gate${'y'.repeat(100)}`, 'gate', 40);

  assert.match(s, /^…/);
  assert.match(s, /…$/);
});

test('a short message is returned whole, with no ellipsis', () => {
  const s = snippet('the gate is free', 'gate', 60);

  assert.equal(s, 'the gate is free');
});

test('a snippet survives a term that is not in the body', () => {
  // The DB matched case-insensitively and a caller may pass a different case,
  // or the match may be outside the body it was given. Falling over here would
  // break a whole result page for one row.
  const s = snippet('a message with no match', 'absent', 10);

  assert.ok(s.length > 0);
});

test('🛑 the match is found case-insensitively, as LIKE finds it', () => {
  // SQLite's LIKE is case-insensitive for ASCII, so a snippet that searched
  // case-sensitively would centre on nothing for half the real matches.
  const s = snippet(`${'x'.repeat(100)}CLAIMING the gate${'y'.repeat(100)}`, 'claiming', 40);

  assert.ok(s.includes('CLAIMING'), `snippet missed the match: ${s}`);
});
