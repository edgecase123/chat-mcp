import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runScript, type ScriptRunner } from '../../src/supervise/run-script.js';

const OPTIONS = { cwd: '/tmp', timeout: 1000, maxBuffer: 2048 };

/**
 * These three endings are only reachable through a socket and a real child
 * otherwise, and the `maxBuffer` one needs a script that emits megabytes — so
 * it had no coverage at all while this logic lived inside the broker.
 */
function runnerYielding(
  err: (Error & { code?: number | string; killed?: boolean }) | null,
  stdout = '',
  stderr = '',
): ScriptRunner {
  return (_file, _args, _options, callback) => callback(err, stdout, stderr);
}

test('no error is exit code 0 and the output', async () => {
  const result = await runScript('/bin/true', [], OPTIONS, runnerYielding(null, 'out', 'err'));

  assert.deepEqual(result, { exitCode: 0, stdout: 'out', stderr: 'err' });
});

test('a numeric code is an ANSWER, carrying the output alongside it', async () => {
  const failed = Object.assign(new Error('Command failed'), { code: 3 });
  const result = await runScript('/bin/false', [], OPTIONS, runnerYielding(failed, 'out', 'err'));

  assert.deepEqual(result, { exitCode: 3, stdout: 'out', stderr: 'err' });
});

/**
 * 🛑 CLASSIFIED BEFORE THE NUMERIC CODE. A timed-out child carries BOTH
 * `killed` and a code, so reading the code first reports a timeout as a
 * legitimate non-zero exit.
 */
test('a killed child is a timeout, not an exit code', async () => {
  const killed = Object.assign(new Error('Command failed'), { code: 143, killed: true });

  await assert.rejects(
    () => runScript('/bin/sleep', ['30'], OPTIONS, runnerYielding(killed)),
    /timed out after 1000ms/,
  );
});

test('an exceeded output budget is a refusal naming the budget', async () => {
  const over = Object.assign(new Error('stdout maxBuffer length exceeded'), {
    code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
    killed: true,
  });

  await assert.rejects(
    () => runScript('/bin/cat', [], OPTIONS, runnerYielding(over)),
    /output exceeded 2048 bytes/,
  );
});

/**
 * ⚠️ THE MAXBUFFER ARM IS CHECKED BEFORE `killed`, AND THIS IS THE CONTROL FOR
 * THAT ORDER. Node sets `killed` on an overflowing child too, so the two
 * fixtures above differ ONLY in `code` — swapping the arms makes this one
 * report a timeout.
 */
test('a spawn failure with no numeric code is a refusal, not a zero exit', async () => {
  const enoent = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });

  await assert.rejects(
    () => runScript('/nope', [], OPTIONS, runnerYielding(enoent)),
    /spawn ENOENT/,
  );
});
