import { test } from 'node:test';
import assert from 'node:assert/strict';

import { assertHandle, isHandle, isRoomName } from '../../src/util/naming.js';

/**
 * 🛑 A HANDLE BECOMES A FILENAME IN SIX PLACES, AND macOS APFS IS
 * CASE-INSENSITIVE. `Alice` and `alice` resolved to one file, so the token
 * store answered `alice`'s own valid token with the handle `Alice` — one agent
 * served another agent's DMs. Lowercase-only is the fix, and it matches
 * `ROOM_RE`, which was already lowercase.
 */
test('🛑 a handle carrying a CAPITAL is refused, because it would share a file with its lowercase twin', () => {
  for (const bad of ['Alice', 'claudE1', 'ABC']) {
    assert.equal(isHandle(bad), false, `isHandle accepted ${JSON.stringify(bad)}`);
    assert.throws(() => assertHandle(bad), /Invalid handle/);
  }

  // The control: the same names in lowercase are legal, so the refusals above
  // are about the case and not about every handle being rejected.
  for (const good of ['alice', 'claude1', 'abc']) {
    assert.equal(isHandle(good), true, `isHandle refused ${JSON.stringify(good)}`);
    assert.doesNotThrow(() => assertHandle(good));
  }
});

/**
 * 🛑 THE TWO PATTERNS MUST AGREE ON CASE, which is the invariant the collision
 * broke. Rooms were lowercase-only and handles were not, and nothing said why.
 */
test('🛑 handles and room names accept the SAME character case', () => {
  assert.equal(isRoomName('#Room'), false);
  assert.equal(isHandle('Room'), false);

  // The control: both accept the lowercase form.
  assert.equal(isRoomName('#room'), true);
  assert.equal(isHandle('room'), true);
});

test('the rest of the handle contract is unchanged', () => {
  // Digits, hyphens and underscores stay legal; a leading underscore does not.
  assert.equal(isHandle('a_b-c9'), true);
  assert.equal(isHandle('_leading'), false);
  assert.equal(isHandle('#room'), false);
  assert.equal(isHandle(''), false);
  assert.equal(isHandle('a'.repeat(64)), true);
  assert.equal(isHandle('a'.repeat(65)), false);

  // `constructor` is a prototype key and still a legal handle. It is lowercase,
  // so this narrowing does not touch it.
  assert.equal(isHandle('constructor'), true);
});
