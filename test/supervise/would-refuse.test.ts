import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * 🛑 THIS IS AN INSTRUMENT, AND AN INSTRUMENT MUST BE SHOWN TO DETECT.
 *
 * The suite stayed green through six separate "we sent the child something it
 * cannot use" bugs. Asserting harder on the sent string did not help, because
 * the assertion was always written after the answer was known.
 *
 * So each test below names a REAL defect, by its commit, and the test fails
 * if the instrument cannot see it. Refusal text is REPLAYED from
 * `test/fixtures/captured-refusals.json`, captured live on runs 6-14 — lee's
 * ruling, 2026-10-31: *"replay the captured refusal text"*.
 */

test('an MCP tool granted as Tool(Tool) is refused — the c7973ee defect', async () => {
  const { wouldRefuse } = await import('../support/would-refuse.js');

  const refusal = wouldRefuse('mcp__chat__set_status', [
    'mcp__chat__set_status(mcp__chat__set_status)',
  ]);

  assert.ok(refusal, 'the instrument cannot see the defect that cost runs 12 and 13');
  assert.match(refusal.refusal, /haven't granted it yet/);
});

test('the same tool granted BARE is permitted', async () => {
  const { wouldRefuse } = await import('../support/would-refuse.js');

  assert.equal(wouldRefuse('mcp__chat__set_status', ['mcp__chat__set_status']), null);
});

test('prose in place of a command is refused — the 468f5dc defect', async () => {
  const { wouldRefuse } = await import('../support/would-refuse.js');

  // What the prompt actually told the child to attempt on run 10.
  const refusal = wouldRefuse("touch in '/tmp/e2e/work/created-by-agent.txt'", [
    'Bash(touch /tmp/e2e/work/created-by-agent.txt)',
  ]);

  assert.ok(refusal, 'prose passed as a command, which is the run-10 bug');
  assert.match(refusal.refusal, /was blocked|requires approval/);
});

test('a Bash command absent from the allowlist is refused', async () => {
  const { wouldRefuse } = await import('../support/would-refuse.js');

  const refusal = wouldRefuse('git -C /tmp/e2e/work push -u origin main', ['Bash(git status)']);

  assert.ok(refusal);
  assert.match(refusal.refusal, /requires approval/);
});

test('a Bash command present in the allowlist is permitted', async () => {
  const { wouldRefuse } = await import('../support/would-refuse.js');

  assert.equal(wouldRefuse('touch /tmp/e2e/f', ['Bash(touch /tmp/e2e/f)']), null);
});

/**
 * ⚠️ THE FIXTURE IS THE POINT, SO GUARD THAT IT IS REALLY BEING READ. A rule
 * set that quietly stopped consulting the captures would still pass every
 * test above with hand-written strings.
 */
test('every refusal returned is a VERBATIM capture, never a hand-written string', async () => {
  const { wouldRefuse } = await import('../support/would-refuse.js');
  const { readFileSync } = await import('node:fs');

  const captures = JSON.parse(readFileSync('test/fixtures/captured-refusals.json', 'utf8'));
  const known = new Set(captures.map((c: { refusal: string }) => c.refusal));

  assert.ok(known.size >= 6, `the corpus shrank to ${known.size} shapes`);

  for (const attempted of [
    'mcp__chat__set_status',
    "touch in '/tmp/e2e/work/created-by-agent.txt'",
    'git -C /tmp/e2e/work push -u origin main',
  ]) {
    const r = wouldRefuse(attempted, ['mcp__chat__set_status(mcp__chat__set_status)']);
    if (r) assert.ok(known.has(r.refusal), `invented a refusal for: ${attempted}`);
  }
});

/**
 * ⚠️ VERBATIM, BUT THE MOST RELEVANT VERBATIM ONE. The first control run
 * replayed approval 10's wording — which names `mcp__chat__list_agents` —
 * for an attempt on `mcp__chat__set_status`. The text was a true capture and
 * the failure message pointed at the wrong tool.
 *
 * Still no editing of captured text. Only the CHOICE between captures of the
 * same shape changes.
 */
test('among captures of one shape, the one naming the attempted tool wins', async () => {
  const { wouldRefuse } = await import('../support/would-refuse.js');

  const refusal = wouldRefuse('mcp__chat__set_status', ['mcp__chat__set_status(x)']);

  assert.ok(refusal);
  assert.match(refusal.refusal, /mcp__chat__set_status/);
  assert.doesNotMatch(refusal.refusal, /list_agents/);
});
