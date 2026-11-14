import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONTAINER_PROJECT_DIR } from '../../src/supervise/drivers/containerized.ts';

/**
 * #221: the container-owned `node_modules` arrives as a named volume, and docker
 * seeds a NEW volume's contents AND OWNERSHIP from the image's directory at the
 * destination. With nothing at that path in the image, the volume root is
 * `root:root` while the process is `uid=10001(agent)` — so `npm ci` fails
 * EACCES. The prelude chains on `&&`, so the agent never starts at all.
 *
 * 🛑 MEASURED, NOT REASONED. On the image built 2026-11-14, a fresh volume at
 * `/work/node_modules` listed `drwxr-xr-x 0 0` and `touch` as agent returned
 * `Permission denied`. The same probe against an image carrying the mkdir and
 * chown below wrote the file. Both probes are recorded in the PR body.
 *
 * ⚠️ WHAT THESE PROVE. They read the Dockerfile, so they prove the instruction
 * has not been deleted or reordered. They do NOT prove the built image behaves
 * — only a real `docker build` plus a write inside it does, and the suite must
 * not need a docker daemon.
 */

const DOCKERFILE = readFileSync(join(process.cwd(), 'Dockerfile'), 'utf8');

/**
 * 🛑 COMMENTS STRIPPED FIRST. The comment above the real instruction names every
 * string these assertions look for, so matching raw bytes would pass with the
 * instruction deleted. That vacuity shipped once on this same Dockerfile — see
 * `dockerfile-github-tooling.test.ts`.
 */
const LINES = DOCKERFILE.split('\n').filter((l) => !l.trimStart().startsWith('#'));

/** `\`-continuations joined, so a directive split across lines is one string. */
const LOGICAL = LINES.join('\n').replace(/\\\n\s*/g, ' ');

test('🛑 the image pre-creates the node_modules mount point, which is what gives the volume agent ownership', () => {
  assert.match(
    LOGICAL,
    /mkdir\s+(-p\s+)?['"]?\/work\/node_modules['"]?/,
    'without a directory at the volume destination, docker seeds the volume root:root and npm ci fails EACCES',
  );
});

test('🛑 and it chowns it to agent, because the ownership is what docker copies onto the volume', () => {
  assert.match(
    LOGICAL,
    /chown\s+(-R\s+)?agent:agent\s+['"]?\/work(\/node_modules)?['"]?/,
    'the mount point existing is not enough; docker copies its OWNERSHIP onto a new volume',
  );
});

/**
 * 🛑 THE ORDERING IS THE GUARD, NOT THE PRESENCE. `mkdir` and `chown` under
 * `/work` need root. Placed after `USER agent` the instructions are still
 * present, still read correctly in review, and the BUILD FAILS.
 */
test('🛑 both run BEFORE `USER agent`, because writing /work needs root', () => {
  const mkdirAt = LINES.findIndex((l) => /mkdir\s+(-p\s+)?['"]?\/work\/node_modules/.test(l));
  const chownAt = LINES.findIndex((l) => /chown\s+(-R\s+)?agent:agent\s+['"]?\/work/.test(l));
  const userAt = LINES.findIndex((l) => /^\s*USER\s+agent\b/.test(l));

  assert.notEqual(mkdirAt, -1, 'no mkdir of /work/node_modules found at all');
  assert.notEqual(chownAt, -1, 'no chown of /work to agent found at all');
  assert.notEqual(userAt, -1, 'no `USER agent` line found — has the image stopped dropping root?');
  assert.ok(
    mkdirAt < userAt,
    `mkdir is at line ${mkdirAt + 1} and USER agent at ${userAt + 1}; /work cannot be created as a non-root user`,
  );
  assert.ok(
    chownAt < userAt,
    `chown is at line ${chownAt + 1} and USER agent at ${userAt + 1}; /work cannot be chowned as a non-root user`,
  );
});

/**
 * ⚠️ CONTROL, AND IT IS THE ONE THAT CATCHES A RENAME. The Dockerfile hardcodes
 * the path; the driver computes it from `CONTAINER_PROJECT_DIR`. Moving the
 * project dir in code would leave this image pre-creating a path nothing mounts,
 * and the EACCES would come straight back with both halves looking correct.
 */
test('⚠️ control — the path the image pre-creates is the path the driver mounts the volume at', () => {
  assert.match(
    LOGICAL,
    new RegExp(`mkdir\\s+(-p\\s+)?['"]?${CONTAINER_PROJECT_DIR}/node_modules['"]?`),
    `the driver mounts the volume at ${CONTAINER_PROJECT_DIR}/node_modules; the image must pre-create THAT path`,
  );
});
