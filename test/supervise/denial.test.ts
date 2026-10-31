import { test } from 'node:test';
import assert from 'node:assert/strict';
import { denialFromClaude, DENIAL_PREFIX } from '../../src/supervise/drivers/claude-events.js';

/**
 * 🛑 THE DENIAL IS STRUCTURED, SO THE DETECTOR MUST NOT GUESS FROM PROSE.
 *
 * Captured verbatim from a real run on 2026-10-31. The whole relay hangs off
 * recognising this, so the fixture is the real string rather than a paraphrase
 * — a paraphrase would make every test below pass against a detector that
 * cannot read what the CLI actually emits.
 *
 * 🛑 IT ALSO EXPLAINS WHY A VAGUE RE-DISPATCH PROMPT FAILS. The text instructs
 * the child not to retry for the rest of the session. The child was obeying an
 * instruction, not being stubborn, and two live runs read as model
 * intransigence before anyone read this string.
 */
const REAL_DENIAL =
  'Permission for this tool use was denied. It requires approval, and this session ' +
  'has no approval surface — nobody can answer a permission prompt here — so it was ' +
  'denied automatically. The action was NOT performed; do not claim it succeeded, and ' +
  'do not retry it: this action, and anything else that requires approval, will be ' +
  'denied the same way for the rest of this session. Tell the user what was blocked ' +
  'and why you needed it, then continue with the parts of the task that do not require ' +
  "approval. What required approval: rm in '/private/tmp/claude-501/perm-none/target.txt' " +
  'was blocked. For security, Claude Code may only remove files from the allowed ' +
  "working directories for this session: '/private/tmp/claude-501/perm-none'.";

function toolResult(content: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', content, ...extra }] },
  };
}

test('the real captured denial is recognised', () => {
  const denial = denialFromClaude(toolResult(REAL_DENIAL));

  assert.ok(denial, 'the detector does not recognise what the CLI actually emits');
});

test('the detector reports WHAT needed approval, not the whole paragraph', () => {
  const denial = denialFromClaude(toolResult(REAL_DENIAL));

  assert.equal(denial?.requested, "rm in '/private/tmp/claude-501/perm-none/target.txt'");
});

/**
 * ⚠️ The full text has to survive, because the relay message to lee is only
 * trustworthy if it can quote the reason rather than summarise it.
 */
test('the detector keeps the full text for quoting', () => {
  const denial = denialFromClaude(toolResult(REAL_DENIAL));

  assert.equal(denial?.raw, REAL_DENIAL);
});

/**
 * 🛑 THE FALSE-POSITIVE SIDE IS THE DANGEROUS ONE. A detector that fires on
 * ordinary output would relay noise to lee and hold a turn that was never
 * blocked.
 */
test('a successful tool result is NOT a denial', () => {
  assert.equal(denialFromClaude(toolResult('total 72\ndrwxr-xr-x  6 leejenkins  wheel  192 .')), null);
});

test('a tool result that merely MENTIONS permission is not a denial', () => {
  const chatter = 'I checked the permission settings and they look fine.';

  assert.equal(denialFromClaude(toolResult(chatter)), null);
});

test('an assistant event is never a denial, whatever it says', () => {
  const event = {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: REAL_DENIAL }] },
  };

  assert.equal(denialFromClaude(event), null, 'the model TALKING about a denial is not a denial');
});

test('a result event is never a denial, whatever it says', () => {
  assert.equal(denialFromClaude({ type: 'result', subtype: 'success', result: REAL_DENIAL }), null);
});

/**
 * ⚠️ `content` is a string in the captured shape, but the protocol allows an
 * array of parts. A detector that assumed a string would silently stop
 * recognising denials the day that changed, and the symptom would be the relay
 * never firing.
 */
test('a denial delivered as content PARTS is still recognised', () => {
  const parts = [{ type: 'text', text: REAL_DENIAL }];

  assert.ok(denialFromClaude(toolResult(parts)), 'array content is not handled');
});

test('malformed events are ignored rather than thrown on', () => {
  for (const junk of [null, undefined, {}, { type: 'user' }, { type: 'user', message: {} }]) {
    assert.doesNotThrow(() => denialFromClaude(junk as Record<string, unknown>));
    assert.equal(denialFromClaude(junk as Record<string, unknown>), null);
  }
});

/**
 * 🛑 THE PREFIX IS A CONTRACT WITH A PROGRAM WE DO NOT CONTROL. If the CLI
 * reworded it, the relay would silently stop firing and a supervised agent
 * would look like it was quietly giving up. Naming it in one place is the only
 * thing that makes that failure findable.
 */
test('the prefix the detector depends on is a named constant', () => {
  assert.ok(REAL_DENIAL.startsWith(DENIAL_PREFIX), 'the prefix no longer matches the real text');
});

test('a denial with no recognisable request clause is still a denial', () => {
  const terse = `${DENIAL_PREFIX} Something was blocked and no clause follows.`;
  const denial = denialFromClaude(toolResult(terse));

  assert.ok(denial, 'a denial must be detected even when the detail cannot be parsed');
  assert.equal(denial?.requested, null, 'an unparsed detail must be null, never a guess');
});
