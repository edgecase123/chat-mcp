import { test } from 'node:test';
import assert from 'node:assert/strict';
import { healthReading } from '../../src/shim/tools/health.js';

/**
 * #138 — the sentence that makes two bare numbers readable.
 *
 * 🛑 IT IS A CLAIM ABOUT WHAT HAPPENED, so every branch needs a test. The
 * first cut asserted "rows were written and are now gone" for ANY inequality,
 * which is confidently wrong when the sequence is the lower of the two. A
 * plausible sentence with nothing behind it is #138's own failure class.
 */

const health = (max_id: number | null, autoincrement_seq: number | null) => ({
  max_id,
  autoincrement_seq,
  schema_version: 15,
});

test('an untouched database says nothing has ever been written', () => {
  assert.match(healthReading(health(null, null)), /No message has ever been written/);
});

test('🛑 marks that agree name the id, so a HIGHER reported id is the fiction', () => {
  const reading = healthReading(health(13504, 13504));

  assert.match(reading, /13504/);
  assert.match(reading, /did not persist/);
});

test('🛑 max_id BELOW the sequence says the row was written and removed', () => {
  const reading = healthReading(health(13503, 13504));

  assert.match(reading, /written and are now gone/);
});

test('🛑 max_id ABOVE the sequence blames the SEQUENCE, not the rows', () => {
  // A restore from a dump that dropped sqlite_sequence. The first cut read
  // this as rows going missing, which is backwards.
  const reading = healthReading(health(13504, 13000));

  assert.match(reading, /sqlite_sequence/);
  assert.doesNotMatch(reading, /now gone/);
});

test('🛑 rows with NO sequence row never render the word null', () => {
  // sqlite_sequence can be absent while messages has rows, again via a dump.
  const reading = healthReading(health(13504, null));

  assert.doesNotMatch(reading, /null/);
  assert.match(reading, /sqlite_sequence/);
});
