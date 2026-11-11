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
 * How long the container may take to appear in `docker ps`.
 *
 * 🛑 `docker run` PULLS THE IMAGE INSIDE THIS BUDGET, and a pull is invisible
 * to `docker ps`. Exceeding it is therefore not evidence the wiring broke.
 * Do not raise it to quiet a red run — read the stderr the rejection now
 * carries and fix the cause it names.
 */
const STARTUP_BOUND_MS = 20000;

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

    // 🛑 THE EVIDENCE A BARE TIMEOUT THREW AWAY. A slow pull, a denied pull,
    // a registry rate limit and a dead daemon all end with no container in
    // `docker ps`, so the startup bound below cannot tell them apart on its
    // own. `docker run` says which one it was on stderr and in its exit code,
    // and nothing was reading either.
    let runStderr = '';
    rawChild.stderr.setEncoding('utf8');
    rawChild.stderr.on('data', (chunk: string) => {
      runStderr += chunk;
    });

    // A spawn failure arrives as an `error` event, never on stderr and never
    // as an exit code. Without this listener it surfaced as a bare
    // `spawn docker ENOENT` with no container name and no stage attached.
    let spawnError: Error | undefined;
    rawChild.on('error', (err: Error) => {
      spawnError = err;
    });

    let runExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    rawChild.on('exit', (code, signal) => {
      runExit = { code, signal };
    });

    /** Everything `docker run` reported, so a rejection names its own cause. */
    const runEvidence = (): string => {
      const lines: string[] = [];
      if (spawnError) lines.push(`spawn error: ${spawnError.message}`);
      lines.push(
        runExit
          ? `docker run exited: code=${runExit.code} signal=${runExit.signal}`
          : 'docker run was still running',
      );
      lines.push(runStderr.trim() ? `docker run stderr:\n${runStderr.trim()}` : 'stderr was empty');
      return lines.join('\n');
    };

    // 🛑 PID 1 INSIDE A CONTAINER IGNORES SIGTERM BY DEFAULT (the kernel's
    // own rule for an init process, not a `sleep` quirk) — `docker stop`
    // always waits out its FULL `-t` window here, it never exits early.
    // A production-sized grace period (#149 raised the default to 60s)
    // would make this test's real `docker stop` take 60s, nearly as long as
    // the safety bound below. Pin it short so the test stays fast and the
    // bound stays a bound, not a race.
    const agentChild = wireAgentChild(
      rawChild,
      { routeEvent: () => undefined, encodeInput: (text) => text },
      { stop: dockerStopFor(name, 2) },
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
          } else if (Date.now() - started > STARTUP_BOUND_MS) {
            clearInterval(poll);
            reject(
              new Error(
                `container ${name} never started within ${STARTUP_BOUND_MS}ms\n${runEvidence()}`,
              ),
            );
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
