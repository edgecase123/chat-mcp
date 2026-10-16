import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * 🛑 A SOURCE assertion, and it exists because a behavioural test missed this.
 *
 * `test/supervise/fallback.test.ts` proves `notifyPeer` FORWARDS a body it is
 * given. It cannot prove the real send paths GIVE one — it calls notifyPeer
 * directly. lee caught exactly that gap: the socket carried a body in every
 * test and no production caller passed it, so every real wake took the
 * "no body, go read your inbox" branch.
 *
 * ⚠️ This is a text assertion, not a behavioural one. It pins the regression
 * without a database fixture; it does not prove the value is correct.
 */
const PATHS = [
  'src/shim/tools/send.ts',
  'src/shim/tools/room_send.ts',
  'src/oneshot/send.ts',
];

test('every real chat send path hands the body to notifyPeer', () => {
  const missing: string[] = [];

  for (const rel of PATHS) {
    const source = readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
    const calls = [...source.matchAll(/notifyPeer\([^;]*?\);/gs)].map((m) => m[0]!);

    assert.ok(calls.length > 0, `${rel} no longer calls notifyPeer — check this test`);

    for (const call of calls) {
      // A chat send always has the text in scope. If a call here stops
      // passing it, every woken agent pays an inbox tool call again.
      if (!/\bbody\b/.test(call)) missing.push(`${rel} drops BODY: ${call.replace(/\s+/g, ' ')}`);

      // `kind` only exists on the two paths that accept it. oneshot/send has
      // no kind parameter, so requiring it there would be a false failure.
      if (/shim\/tools\/(room_)?send\.ts/.test(rel) && !/\bkind\b/.test(call)) {
        missing.push(`${rel} drops KIND: ${call.replace(/\s+/g, ' ')}`);
      }
    }
  }

  assert.deepEqual(missing, [], `these sends drop the body:\n${missing.join('\n')}`);
});
