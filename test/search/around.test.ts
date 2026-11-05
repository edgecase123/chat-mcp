import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aroundWindow,
  parseAroundId,
  readerIsPartyToDm,
  targetForMessage,
} from '../../src/search/around.js';

/**
 * 🛑 A MESSAGE ID WAS UNREACHABLE FROM THE UI (#104).
 *
 * Agents refer to messages by id. "See 12582" was nothing to the human reading
 * the same room, who could only scroll.
 */

test('🛑 a loose integer is REFUSED, not silently coerced', () => {
  // parseInt('12x') is 12 and parseInt('') is NaN, so a hand-edited fragment
  // would otherwise resolve the wrong message or reach the DAO as NaN.
  assert.equal(parseAroundId('12x').ok, false);
  assert.equal(parseAroundId('').ok, false);
  assert.equal(parseAroundId(null).ok, false);
  assert.equal(parseAroundId(undefined).ok, false);
  assert.equal(parseAroundId(' 12').ok, false);
  assert.equal(parseAroundId('12.5').ok, false);
  assert.equal(parseAroundId('-3').ok, false);
  assert.equal(parseAroundId('0').ok, false, 'ids start at 1');
  assert.equal(parseAroundId('1e3').ok, false, 'exponent notation is not an id');
});

test('a plain positive integer is accepted', () => {
  assert.deepEqual(parseAroundId('12582'), { ok: true, id: 12582 });
  assert.deepEqual(parseAroundId('1'), { ok: true, id: 1 });
});

test('⚠️ an id past Number.MAX_SAFE_INTEGER is refused rather than rounded', () => {
  assert.equal(parseAroundId('9007199254740993').ok, false);
});

test('🛑 a DM resolves to the OTHER party, and which one depends on who asks', () => {
  const sent = { from_handle: 'leejenkins', to_handle: 'claude2' };
  const received = { from_handle: 'claude2', to_handle: 'leejenkins' };

  // Both rows belong to the SAME conversation from lee's seat.
  assert.equal(targetForMessage(sent, 'leejenkins'), 'claude2');
  assert.equal(targetForMessage(received, 'leejenkins'), 'claude2');

  // And to the same one from claude2's seat, named the other way.
  assert.equal(targetForMessage(sent, 'claude2'), 'leejenkins');
  assert.equal(targetForMessage(received, 'claude2'), 'leejenkins');
});

test('⚠️ control — `to_handle` alone is wrong half the time', () => {
  // The naive implementation. If this ever agrees with targetForMessage on
  // both rows, the seat-dependence has been lost.
  const sent = { from_handle: 'leejenkins', to_handle: 'claude2' };
  const received = { from_handle: 'claude2', to_handle: 'leejenkins' };

  assert.equal(sent.to_handle, targetForMessage(sent, 'leejenkins'));
  assert.notEqual(received.to_handle, targetForMessage(received, 'leejenkins'));
});

test('a room is its own target, whoever is asking', () => {
  const room = { from_handle: 'claude1', to_handle: '#leagues' };

  assert.equal(targetForMessage(room, 'leejenkins'), '#leagues');
  assert.equal(targetForMessage(room, 'claude2'), '#leagues');
});

test('🛑 a DM the reader is not a party to is REFUSED', () => {
  const theirs = { from_handle: 'claude1', to_handle: 'claude2' };

  assert.equal(readerIsPartyToDm(theirs, 'leejenkins'), false);
  assert.equal(readerIsPartyToDm(theirs, 'claude1'), true);
  assert.equal(readerIsPartyToDm(theirs, 'claude2'), true);
});

test('⚠️ a ROOM message is never "a DM I am party to" — rooms check membership', () => {
  // Returning true here would let the room branch skip `isRoomMember`, which
  // is the bypass this function exists to avoid.
  const room = { from_handle: 'claude1', to_handle: '#leagues' };

  assert.equal(readerIsPartyToDm(room, 'claude1'), false);
  assert.equal(readerIsPartyToDm(room, 'leejenkins'), false);
});

test('the anchor lands mid-window, with the extra row going to the OLDER side', () => {
  // The reader followed a link; the context they want is what came before it.
  assert.deepEqual(aroundWindow(101), { before: 50, after: 50 });
  assert.deepEqual(aroundWindow(100), { before: 50, after: 49 });
  assert.deepEqual(aroundWindow(2), { before: 1, after: 0 });
});

test('⚠️ a window of 1 is the anchor alone, not a negative span', () => {
  assert.deepEqual(aroundWindow(1), { before: 0, after: 0 });
  assert.deepEqual(aroundWindow(0), { before: 0, after: 0 });
  assert.deepEqual(aroundWindow(-5), { before: 0, after: 0 });
});

test('🛑 before + after + the anchor never exceeds the limit', () => {
  for (const limit of [1, 2, 3, 10, 99, 100, 500]) {
    const { before, after } = aroundWindow(limit);

    assert.equal(before + after + 1, Math.max(1, limit), `limit ${limit}`);
  }
});
