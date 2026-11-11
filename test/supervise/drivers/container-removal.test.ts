import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { wireAgentChild } from '../../../src/supervise/drivers/wiring.js';
import { containerNameFor, dockerStopFor } from '../../../src/supervise/drivers/containerized.js';

function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * 🛑 FORCE-REMOVE IN A `finally`, EVERY TIME. A first version of this test
 * left a live container behind on BOTH assertion failure and timeout —
 * reproduced on two separate machines (claude1, then claude2 independently),
 * one of which hung 3+ minutes with no bound at all before this cleanup
 * existed. Whatever this test concludes about `kill()`, it must not itself
 * be the thing that leaks a container.
 *
 * 🛑 GOES THROUGH `wireAgentChild`, NOT A BARE `child.kill()`. A bare SIGTERM
 * to the `docker run -i` client is ignored by the daemon outright, so a test
 * that calls `child.kill()` directly can never prove anything about removal
 * — it was passing #148's old `todo` exactly because of that. `kill()`'s
 * `stop` override is what actually reaches the daemon (`docker stop`), so
 * this exercises that override the same way `spawnContainerized` wires it.
 *
 * 🛑 USES `dockerStopFor` FROM PRODUCTION, NOT A COPY. A hand-written `stop`
 * closure here would prove `docker stop` removes a container; it would not
 * prove `spawnContainerized` is wired to call it (claude2, PR #147 review).
 */
test(
  '🛑 AgentChild.kill() on a containerized child removes the --rm container',
  { skip: dockerAvailable() ? false : 'docker is not available here' },
  async () => {
    const name = containerNameFor(`removal-test-${process.pid}`);
    const rawChild = spawn('docker', [
      'run',
      '-i',
      '--rm',
      '--name',
      name,
      'alpine',
      'sleep',
      '300',
    ]) as ChildProcessWithoutNullStreams;

    const agentChild = wireAgentChild(
      rawChild,
      { routeEvent: () => undefined, encodeInput: (text) => text },
      { stop: dockerStopFor(name) },
    );

    try {
      // Wait for the container to actually exist before killing it, otherwise
      // a pass could mean "it never started".
      await new Promise((resolve, reject) => {
        const started = Date.now();
        const poll = setInterval(() => {
          const out = execFileSync('docker', ['ps', '-q', '-f', `name=${name}`]).toString().trim();
          if (out) {
            clearInterval(poll);
            resolve(undefined);
          } else if (Date.now() - started > 20000) {
            clearInterval(poll);
            reject(new Error('container never started'));
          }
        }, 200);
      });

      agentChild.kill();

      // 🛑 60s IS A SAFETY BOUND, NOT AN EXPECTATION. `docker stop` SIGTERMs
      // PID 1 and waits out a grace period before SIGKILL, so this is slower
      // than a raw kill by design — the bound exists so a broken `stop` still
      // fails loudly inside a minute instead of hanging.
      await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('docker run did not exit within 60s of kill()')),
          60000,
        );
        rawChild.on('exit', () => {
          clearTimeout(timer);
          resolve(undefined);
        });
      });

      // `--rm` removal is asynchronous, so poll rather than reading once.
      const gone = await new Promise<boolean>((resolve) => {
        const started = Date.now();
        const poll = setInterval(() => {
          const out = execFileSync('docker', ['ps', '-a', '-q', '-f', `name=${name}`])
            .toString()
            .trim();
          if (!out) {
            clearInterval(poll);
            resolve(true);
          } else if (Date.now() - started > 20000) {
            clearInterval(poll);
            resolve(false);
          }
        }, 300);
      });

      assert.ok(gone, `container ${name} was still listed by docker ps -a after kill()`);
    } finally {
      // Belt and suspenders: whether the assertion above passed, failed, or
      // threw, make sure nothing with this name survives this test.
      try {
        execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
      } catch {
        // Already gone — the expected case when the test actually passed.
      }
    }
  },
);
