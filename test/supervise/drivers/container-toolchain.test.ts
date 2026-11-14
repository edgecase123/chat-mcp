import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IMAGE_TAG } from '../../../src/supervise/container.js';
import {
  CONTAINER_PROJECT_DIR,
  CONTAINER_NODE_MODULES_DIR,
  nodeModulesInstallStep,
  prelude,
} from '../../../src/supervise/drivers/containerized.js';
import { claudeSpawn } from '../../../src/adapters/claude-spawn.js';
import { dockerLaneSkip } from '../../support/docker-lane.js';

/**
 * #233. `npm ci --ignore-scripts` means a dependency needing its postinstall
 * never gets one. `npm` reports success, the volume looks populated, and the
 * failure surfaces much later as an import error inside a running agent —
 * several minutes and one container away from the install that caused it.
 *
 * 🛑 IN THE SUITE, NOT THE PRELUDE. lee's ruling: *"In the suite, as a
 * container test"*. A fourth prelude step that can fail means no agent starts
 * at all, which is the consequence #221 spent three blockers on. The cost
 * accepted with that ruling is that this fires only when someone runs the
 * suite.
 *
 * 🛑 IT TRANSFORMS A REAL `.ts` FILE. IT DOES NOT RUN `-e ''`. The ticket
 * proposed `node --import tsx -e ''` as the cheap form, and that form FAILS
 * OPEN. Measured in this image against a wrong-architecture `node_modules`:
 *
 * | node_modules        | `--import tsx -e ''` | `--import tsx file.ts` |
 * |---------------------|----------------------|------------------------|
 * | empty               | EXIT 1               | n/a                    |
 * | wrong architecture  | **EXIT 0**           | EXIT 1 `TransformError`|
 *
 * `-e ''` proves tsx's JavaScript RESOLVES. It never reaches esbuild's native
 * binary, which is exactly what a skipped postinstall leaves broken. A
 * transform does.
 */

function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * The agent image must already exist. Building it is 1.18 GB and minutes, and
 * #150's ruling is that a test must not spend an image build inside its own
 * startup budget.
 */
function imageSkip(): string | false {
  const lane = dockerLaneSkip(process.env, dockerAvailable);
  if (lane !== false) return lane;

  const found = spawnSync('docker', ['images', '-q', IMAGE_TAG], { encoding: 'utf8' });
  if (found.status !== 0 || !found.stdout.trim()) {
    return `${IMAGE_TAG} is not built here; run \`./scripts/agent start <handle>\` once`;
  }

  return false;
}

/** A budget for a cold `npm ci` of the whole lockfile, plus the transform. */
const INSTALL_BOUND_MS = 600_000;

/**
 * A `.ts` file that only compiles if the transform really ran. A `.js` file
 * would load with no toolchain at all, and an empty `.ts` file is transformed
 * to nothing — so neither could fail.
 */
const PROBE_SOURCE = 'const answer: number = 41 + 1;\nprocess.stdout.write(`TS_RAN:${answer}`);\n';

interface ContainerRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Run a shell command in the agent image, with this checkout at `/work` and a
 * throwaway named volume over `/work/node_modules`.
 *
 * ⚠️ THE CHECKOUT IS MOUNTED `:ro`. The install writes only into the volume,
 * and a read-only bind is what proves it — the same tree the host supervisor
 * runs from must not gain a `dist/` or a `node_modules` from a test.
 */
function inImage(volume: string, script: string): ContainerRun {
  const ran = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '-v',
      `${process.cwd()}:${CONTAINER_PROJECT_DIR}:ro`,
      '-v',
      `${volume}:${CONTAINER_PROJECT_DIR}/${CONTAINER_NODE_MODULES_DIR}`,
      '-w',
      CONTAINER_PROJECT_DIR,
      IMAGE_TAG,
      'sh',
      '-c',
      script,
    ],
    { encoding: 'utf8', timeout: INSTALL_BOUND_MS },
  );

  return { status: ran.status, stdout: ran.stdout ?? '', stderr: ran.stderr ?? '' };
}

function removeVolume(volume: string): void {
  try {
    execFileSync('docker', ['volume', 'rm', '-f', volume], { stdio: 'ignore' });
  } catch {
    // Never created, or already gone.
  }
}

/**
 * 🛑 THE ASSERTION #233 ASKS FOR, AND IT RUNS THE PRODUCTION INSTALL STEP.
 * A hand-written `npm ci` here would prove npm works. It would not prove the
 * step this project actually spawns produces a `node_modules` the toolchain
 * can use — which is the whole claim, because `--ignore-scripts` is in that
 * step and nowhere else.
 */
test(
  '🛑 the node_modules the install step builds can actually TRANSFORM TypeScript',
  { skip: imageSkip() },
  () => {
    const volume = `chat-mcp-toolchain-test-${process.pid}`;
    const probeDir = mkdtempSync(join(tmpdir(), 'chat-mcp-toolchain-'));
    const probe = join(probeDir, 'probe.ts');

    writeFileSync(probe, PROBE_SOURCE);

    try {
      // The real step, against the real lockfile, inside the real image.
      const install = inImage(volume, prelude([nodeModulesInstallStep(claudeSpawn)]));

      assert.equal(
        install.status,
        0,
        `the install step failed inside ${IMAGE_TAG}\nstderr:\n${install.stderr}`,
      );

      const ran = inImage(
        volume,
        `cat > /tmp/probe.ts <<'PROBE'\n${PROBE_SOURCE}PROBE\n` +
          'node --import tsx /tmp/probe.ts',
      );

      assert.equal(
        ran.status,
        0,
        `the toolchain cannot transform TypeScript on the volume the install built — ` +
          `a dependency needing its postinstall is the likely cause (#233)\n` +
          `stderr:\n${ran.stderr}`,
      );
      assert.match(ran.stdout, /TS_RAN:42/, `the transform produced no output; stdout: ${ran.stdout}`);
    } finally {
      removeVolume(volume);
    }
  },
);

/**
 * ⚠️ THE PAIRED CONTROL, AND IT IS WHAT SEPARATES A REAL CHECK FROM ONE THAT
 * CANNOT FAIL. Without the install, the volume is the empty directory docker
 * seeds from the image layer — so if the assertion above passed here too, it
 * would be measuring nothing about the install at all.
 *
 * 🛑 IT IS ALSO THE PROOF THAT A TRANSFORM BEATS `-e ''`. This control uses
 * the SAME probe as the test above; the difference between them is the
 * install, and nothing else.
 */
test(
  '⚠️ control — with NO install, the same probe FAILS, so the check can say no',
  { skip: imageSkip() },
  () => {
    const volume = `chat-mcp-toolchain-control-${process.pid}`;

    try {
      const ran = inImage(
        volume,
        `cat > /tmp/probe.ts <<'PROBE'\n${PROBE_SOURCE}PROBE\n` +
          'node --import tsx /tmp/probe.ts',
      );

      assert.notEqual(
        ran.status,
        0,
        'the probe passed with an EMPTY node_modules, so it proves nothing about the install',
      );
    } finally {
      removeVolume(volume);
    }
  },
);

/**
 * 🔴 #242. THE LAYER ORDER, GUARDED. `Dockerfile`'s `useradd` chowns `/root`,
 * and the `npm ci` BELOW it runs as root with `HOME=/root` — so it repopulated
 * `/root/.npm/_cacache` after that chown and left 1073 root-owned paths in a
 * cache the agent has to write. A cold `npm ci` as `agent` died `EACCES`, the
 * prelude chains on `&&`, and no agent started at all.
 *
 * 🛑 IT ASSERTS OWNERSHIP, NOT THE CHOWN LINE. A test grepping the
 * `Dockerfile` would pass on a build that never ran, and would say nothing
 * about a future root-run layer added below the fix. This reads the built
 * image, which is the only thing a spawn actually uses.
 *
 * ⚠️ IT IS NOT A SUBSTITUTE FOR THE INSTALL TEST ABOVE. This fails on the
 * CAUSE; that one fails on the CONSEQUENCE. Ownership could be correct and the
 * toolchain still unusable for an unrelated reason.
 */
test(
  '🔴 nothing under /root in the agent image is owned by anyone but agent',
  { skip: imageSkip() },
  () => {
    const ran = spawnSync(
      'docker',
      ['run', '--rm', IMAGE_TAG, 'sh', '-c', 'find /root ! -user agent | head -20'],
      { encoding: 'utf8', timeout: 120_000 },
    );

    assert.equal(ran.status, 0, `could not inspect ${IMAGE_TAG}\nstderr:\n${ran.stderr}`);
    assert.equal(
      ran.stdout.trim(),
      '',
      'a root-owned path under /root means a cold `npm ci` as agent can die EACCES, ' +
        `and the prelude's && chain then starts no agent (#242):\n${ran.stdout}`,
    );
  },
);
