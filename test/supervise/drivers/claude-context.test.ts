import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  usedFromUsage,
  parseClaudeContextUsed,
  parseClaudeModel,
  contextWindowForModel,
  FALLBACK_CONTEXT_WINDOW,
  type ClaudeUsage,
} from '../../../src/supervise/drivers/claude-events.js';

/**
 * 🛑 `output_tokens` MUST NOT BE COUNTED, and #213 says to count it.
 *
 * Measured on a live Opus 5 session against Claude Code's own `/context`,
 * which printed `118.8k`. Including output overstates by one turn's output on
 * every report, so the container gauge would read high against the host's
 * forever.
 */
test('the live window sum excludes output tokens', () => {
  const measured = {
    input_tokens: 2,
    cache_read_input_tokens: 115_680,
    cache_creation_input_tokens: 3_101,
    output_tokens: 577,
  };

  assert.equal(usedFromUsage(measured), 118_783);
});

test('used is what the model was SENT, summing the three input fields', () => {
  assert.equal(
    usedFromUsage({ input_tokens: 2, cache_read_input_tokens: 730_686, cache_creation_input_tokens: 1_130 }),
    731_818,
  );
});

test('output tokens are excluded even when they dwarf the input', () => {
  assert.equal(usedFromUsage({ input_tokens: 100, output_tokens: 9_999 } as ClaudeUsage), 100);
});

test('a missing field counts as zero rather than NaN', () => {
  assert.equal(usedFromUsage({ cache_read_input_tokens: 50 }), 50);
  assert.equal(usedFromUsage({}), 0);
});

test('an assistant event yields the live window size', () => {
  const event = {
    type: 'assistant',
    message: { usage: { input_tokens: 10, cache_read_input_tokens: 90 } },
  };

  assert.equal(parseClaudeContextUsed(event), 100);
});

/**
 * 🛑 ONE EVENT TYPE REPORTS, AND IT IS `assistant`. A `result` event carries a
 * `usage` block too. Reading both is redundant rather than wrong, but only
 * `assistant` matches the transcript entry the host hook reads — so host and
 * container agree by construction.
 */
test('a result event reports nothing even though it carries usage', () => {
  const event = {
    type: 'result',
    message: { usage: { input_tokens: 6, cache_read_input_tokens: 52_194 } },
  };

  assert.equal(parseClaudeContextUsed(event), null);
});

test('an assistant event with no usage reports nothing', () => {
  assert.equal(parseClaudeContextUsed({ type: 'assistant', message: {} }), null);
});

/**
 * ⚠️ THE EVENT IS `type: "system"`, `subtype: "init"` — NOT `type: "init"`.
 * #213 calls it "the init event", which is the shape a reader would write.
 */
test('the model id comes off the system init event', () => {
  const event = { type: 'system', subtype: 'init', model: 'claude-sonnet-5-5' };

  assert.equal(parseClaudeModel(event), 'claude-sonnet-5-5');
});

test('a bare init type is not the init event and yields no model', () => {
  assert.equal(parseClaudeModel({ type: 'init', model: 'claude-opus-5' }), null);
});

test('opus 5 maps to the window /context reported for it', () => {
  assert.equal(contextWindowForModel('claude-opus-5'), 1_000_000);
});

test('haiku 4.5 is the one current model that is not a megatoken', () => {
  assert.equal(contextWindowForModel('claude-haiku-4-5'), 200_000);
});

/**
 * 🛑 AN UNKNOWN ID RETURNS null, SO THE CALLER MUST CHOOSE AND SAY SO. The
 * caller falls back to `FALLBACK_CONTEXT_WINDOW` and logs the id. Returning
 * the fallback from here would make an unmapped model indistinguishable from
 * a mapped 1M one, and nothing would ever get logged.
 */
test('an unmapped model id is null, not a guess', () => {
  assert.equal(contextWindowForModel('claude-sonnet-5-5'), null);
  assert.equal(contextWindowForModel(''), null);
  assert.equal(FALLBACK_CONTEXT_WINDOW, 1_000_000);
});
