import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classify, corpusSize } from '../support/would-refuse.js';

/**
 * 🛑 THE FIRST VERSION OF THIS FILE PASSED WHILE THE MODEL ANSWERED 5 OF 7
 * CAPTURES WRONGLY. It probed three inputs against a seven-record corpus and
 * never printed that denominator, so it certified three branches and read as
 * certifying the model. claude1 found it on PR 43.
 *
 * The first test below is the one that would have caught it: it checks EVERY
 * record and names the count.
 */

const CORPUS = JSON.parse(readFileSync('test/fixtures/captured-refusals.json', 'utf8')) as {
  outcome: string;
  approvalId: number;
  attempted: string;
  allowlist: string[] | null;
}[];

test('EVERY refused capture classifies as refused — N of N, with the count named', () => {
  const refused = CORPUS.filter((r) => r.outcome === 'refused');

  assert.ok(refused.length >= 10, `the corpus shrank to ${refused.length} refusals`);

  const wrong: string[] = [];

  for (const r of refused) {
    // 🛑 EACH RECORD'S OWN ALLOWLIST. A refusal is only evidence under the
    // allowlist it happened beneath, so asking under a different one is a
    // different question. Rows that predate the column answer for "nothing
    // granted", which is `[]`.
    const v = classify(r.attempted, r.allowlist ?? []);

    if (v.kind !== 'refused') wrong.push(`approval ${r.approvalId} -> ${v.kind}: ${r.attempted}`);
  }

  assert.deepEqual(
    wrong,
    [],
    `${wrong.length} of ${refused.length} captured refusals are answered wrongly:\n  ${wrong.join('\n  ')}`,
  );
});

test('the one measured success classifies as permitted, and names its evidence', () => {
  const v = classify('mcp__chat__set_status', ['mcp__chat__set_status']);

  assert.equal(v.kind, 'permitted');

  const evidence = v.kind === 'permitted' ? v.record.evidence : '';

  assert.match(evidence, /e2e-ok-62471/, 'the evidence does not name the sentinel');

  // 🛑 IT MUST SAY IT IS HISTORICAL. Building the fixture by re-reading the
  // live row produced "became MISSING": that row is transient and had already
  // been cleared when the agent deregistered. A capture that reads as
  // re-verifiable invites someone to re-run the query and conclude it was
  // never true.
  assert.match(evidence, /HISTORICAL/, 'the evidence implies it can be re-read');
});

test('the SAME command with a Tool(Tool) allowlist is NOT permitted — the c7973ee defect', () => {
  const v = classify('mcp__chat__set_status', ['mcp__chat__set_status(mcp__chat__set_status)']);

  // ⚠️ `unknown` IS THE HONEST ANSWER, AND IT STILL CATCHES THE DEFECT.
  // Run 12's approval 24 did attempt this under exactly that allowlist, but
  // it predates the allowlist column, so the corpus cannot speak for it.
  // What matters is that it is never `permitted`: the chain test demands
  // `permitted`, so unknown fails there just as a refusal would.
  assert.notEqual(v.kind, 'permitted', 'Tool(Tool) was certified as working, the run-12 bug');
});

test('a compound command is refused even when the whole line is allowlisted', () => {
  // ⚠️ SOURCED FROM THE CORPUS, not written here. A hardcoded path drifted the
  // moment normalise() changed, and the test then failed for the wrong reason.
  const record = CORPUS.find((r) => r.outcome === 'refused' && /;|&&/.test(r.attempted));

  assert.ok(record, 'the corpus holds no compound command, so this proves nothing');

  const v = classify(record.attempted, record.allowlist ?? []);

  assert.equal(v.kind, 'refused', 'the compound case that cost c12c81d was certified as working');
});

test('an unrecognised command is UNKNOWN, never permitted', () => {
  const v = classify('echo hello', ['Bash(echo hello)']);

  assert.equal(v.kind, 'unknown');
  assert.match(v.kind === 'unknown' ? v.reason : '', /Capture it from a live run/);
});

test('prose where a command belonged is UNKNOWN — the 468f5dc defect still fails', () => {
  const v = classify("touch in '/tmp/e2e/work/created-by-agent.txt'", [
    'Bash(touch /tmp/e2e/work/created-by-agent.txt)',
  ]);

  assert.notEqual(v.kind, 'permitted', 'prose was certified as runnable');
});

test('the corpus still holds both outcomes, so neither branch is dead', () => {
  const { refused, permitted } = corpusSize();

  assert.ok(refused >= 10, `only ${refused} refusals`);
  assert.equal(permitted, 1, `expected the single measured success, got ${permitted}`);
});
