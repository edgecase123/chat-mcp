import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error — plain JS module, no types, same as the other logic tests.
import { claimRow, claimsPanelEmpty } from '../../web/assets/logic.js';

/**
 * 🛑 THE PANEL IS WHAT MAKES A CLAIM A FACT RATHER THAN A SENTENCE.
 *
 * Before #101, "who holds the gate" lived in chat scrollback. The operator had
 * to read it, understand it and remember it, and it scrolled out of view while
 * still being held.
 */

const held = (over: Record<string, unknown> = {}) => ({
  resource: 'reset-and-test.sh',
  holder: 'claude1',
  note: null,
  held_for_minutes: 12,
  expires_in_minutes: 228,
  ...over,
});

test('a row leads with the age, because that is the number an operator acts on', () => {
  const r = claimRow(held({ held_for_minutes: 41 }), { me: 'claude2' });

  assert.equal(r.age, 'held 41m');
  assert.equal(r.resource, 'reset-and-test.sh');
  assert.equal(r.holder, 'claude1');
});

test('hours read as hours, so a long hold is legible at a glance', () => {
  assert.equal(claimRow(held({ held_for_minutes: 59 }), {}).age, 'held 59m');
  assert.equal(claimRow(held({ held_for_minutes: 60 }), {}).age, 'held 1h');
  assert.equal(claimRow(held({ held_for_minutes: 125 }), {}).age, 'held 2h 5m');
  assert.equal(claimRow(held({ held_for_minutes: 480 }), {}).age, 'held 8h');
});

test("the viewer's own claim is marked, so they can tell what to release", () => {
  assert.equal(claimRow(held({ holder: 'claude2' }), { me: 'claude2' }).mine, true);
  assert.equal(claimRow(held({ holder: 'claude1' }), { me: 'claude2' }).mine, false);

  // No viewer is not the same as "it is mine".
  assert.equal(claimRow(held({ holder: 'claude1' }), {}).mine, false);
});

test('🛑 STALE means outliving any legitimate hold, not nearing expiry', () => {
  // The failsafe is four hours and a full gate is about 23 minutes, so a
  // claim near expiry is already far past suspicious. Flagging on remaining
  // time would mark nothing until hour four, which is three hours too late.
  assert.equal(claimRow(held({ held_for_minutes: 23 }), {}).stale, false, 'one gate is normal');
  assert.equal(claimRow(held({ held_for_minutes: 59 }), {}).stale, false);
  assert.equal(claimRow(held({ held_for_minutes: 60 }), {}).stale, true, 'an hour is the line');

  // A claim made moments ago with a short failsafe left is NOT stale — the
  // flag must not read the wrong end.
  assert.equal(claimRow(held({ held_for_minutes: 2, expires_in_minutes: 1 }), {}).stale, false);
});

test('the expiry is reported as a failsafe, in the quieter half of the row', () => {
  const r = claimRow(held({ expires_in_minutes: 199 }), {});

  assert.equal(r.expiry, 'failsafe in 3h 19m');
  assert.notEqual(r.age, r.expiry, 'the two numbers must not be interchangeable');
});

test('a note survives, and an empty one becomes null rather than an empty row', () => {
  assert.equal(claimRow(held({ note: 'mode=all, 66ef2fe8' }), {}).note, 'mode=all, 66ef2fe8');
  assert.equal(claimRow(held({ note: '' }), {}).note, null);
  assert.equal(claimRow(held({ note: null }), {}).note, null);
});

test('🛑 an empty panel SAYS it is empty, rather than rendering blank', () => {
  // A blank panel and a panel that failed to load look identical. That
  // ambiguity is #103's frozen gauge in a different place.
  assert.match(claimsPanelEmpty(), /nothing claimed/i);
});
