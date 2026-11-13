import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { wireAgentChild } from '../../../src/supervise/drivers/wiring.js';
import { assertDeclaresCapabilities } from '../../../src/supervise/child.js';
import { claudeSpawn } from '../../../src/adapters/claude-spawn.js';

/**
 * `wireAgentChild` used to hard-code `reportsUsage: true` and
 * `reportsContext: true` for every vendor, while the sinks those declarations
 * promise are optional on the router. So a vendor whose `routeEvent` never
 * calls them still announced that a reading was coming, and the operator was
 * told "awaiting the first reading" forever.
 *
 * 🛑 THE DECLARATION IS THE VENDOR'S, NOT THE WIRING'S. #219.
 */

function fakeProcess() {
  return {
    stdout: new PassThrough(),
    stdin: new PassThrough(),
    on: () => undefined,
    kill: () => undefined,
  };
}

const INERT = { routeEvent: () => undefined, encodeInput: (t: string) => t };

test('a vendor declaring it reports neither reading is wired as reporting neither', () => {
  const agent = wireAgentChild(fakeProcess() as never, {
    ...INERT,
    reportsUsage: false,
    reportsContext: false,
  });

  assert.equal(agent.reportsUsage, false);
  assert.equal(agent.reportsContext, false);
});

test('a vendor declaring it reports both is wired as reporting both', () => {
  // The positive control. Without it the test above passes against a wiring
  // that hard-codes `false`, which is the same defect pointed the other way.
  const agent = wireAgentChild(fakeProcess() as never, {
    ...INERT,
    reportsUsage: true,
    reportsContext: true,
  });

  assert.equal(agent.reportsUsage, true);
  assert.equal(agent.reportsContext, true);
});

test('🛑 the two declarations do not cross — each field carries its OWN vendor value', () => {
  // A wiring that read one field for both would pass every same-value case
  // above and still mislead an operator about exactly one gauge.
  for (const usage of [true, false]) {
    const agent = wireAgentChild(fakeProcess() as never, {
      ...INERT,
      reportsUsage: usage,
      reportsContext: !usage,
    });

    assert.equal(agent.reportsUsage, usage);
    assert.equal(agent.reportsContext, !usage);
  }
});

test('🛑 a vendor that declares NOTHING is refused, rather than wired as reporting both', () => {
  // `tsconfig.json` includes `src/**` only, so a JavaScript vendor or a test
  // fake omitting a field compiles and runs. The hard-coded `true` used to
  // launder that omission into a confident declaration; now the omission
  // reaches `assertDeclaresCapabilities` and stops there.
  const agent = wireAgentChild(fakeProcess() as never, INERT as never);

  assert.throws(() => assertDeclaresCapabilities(agent), /reportsUsage/);
});

test('the Claude Code vendor declares that it reports both readings', () => {
  // It genuinely routes both. This is the one vendor that exists, so it is
  // also the only place the production value of these fields is asserted.
  assert.equal(claudeSpawn.reportsUsage, true);
  assert.equal(claudeSpawn.reportsContext, true);
});
