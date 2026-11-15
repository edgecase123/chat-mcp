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

/**
 * One entry per LOGICAL directive, so a `\`-continuation chain is one string.
 *
 * 🛑 INDEXING `LINES` IS WHAT FAILED OPEN. A root-run `npm` written as a chain
 * puts `RUN` on one line and `npm` on the next, so a single-line pattern
 * matches neither — and four of this file's `RUN` directives already use that
 * shape. Found by claude2 on PR 243 with a single-line positive control.
 */
const DIRECTIVES = LOGICAL.split('\n');

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

/**
 * 🔴 #242, AND IT IS THE SAME CLASS AS THE ORDERING TEST ABOVE. The `useradd`
 * chowns `/root`, and a later `npm ci` runs as ROOT with `HOME=/root` — so it
 * repopulates `/root/.npm/_cacache` AFTER that chown. 1073 paths were left
 * root-owned in a cache the agent then has to write, a cold `npm ci` as `agent`
 * died `EACCES: mkdir /root/.npm/_cacache/...`, the prelude's `&&` held, and NO
 * AGENT STARTED.
 *
 * 🛑 THIS RUNS IN CI AND THE IMAGE TEST DOES NOT. `container-toolchain.test.ts`
 * reads the BUILT image, which is stronger — and it is docker-lane-only, so
 * `ci.yml`'s plain `npm test` skips it. Nothing would stop the ordering
 * regressing on `main`. Raised by claude2 on PR 243.
 *
 * ⚠️ THE TWO ARE NOT REDUNDANT. This proves the instruction is in the right
 * PLACE; the image test proves the built result. A Dockerfile can be correct
 * and the published image stale, and a build can be correct while a future
 * root-run layer lands below this chown.
 */
test('🔴 /root is chowned to agent AFTER the last root-run npm, or a cold npm ci dies EACCES', () => {
  const userAt = DIRECTIVES.findIndex((d) => /^\s*USER\s+agent\b/.test(d));
  const isRootNpm = (d: string) => /^\s*RUN\b[\s\S]*\bnpm\s+(ci|install)\b/.test(d);
  // 🛑 `\s/root\b` ALSO MATCHED `/root/.config`, because `/` ends a word. A
  // chown narrowed to a subdirectory left /root/.npm root-owned and passed.
  const chownsRoot = (d: string) => /chown\s+(-R\s+)?agent:agent\b[^\n]*\s\/root(\s|$)/.test(d);

  assert.notEqual(userAt, -1, 'no `USER agent` line — has the image stopped dropping root?');

  const rootNpm = DIRECTIVES.filter((d, i) => isRootNpm(d) && i < userAt);
  const chownRoot = DIRECTIVES.map((d, i) => (chownsRoot(d) ? i : -1)).filter((i) => i !== -1);

  assert.ok(rootNpm.length > 0, 'no root-run `npm ci`/`npm install` found before USER agent');
  assert.ok(
    chownRoot.length > 0,
    'nothing chowns /root to agent at all; the npm cache lives at /root/.npm (#242)',
  );

  const lastNpmAt = DIRECTIVES.lastIndexOf(rootNpm[rootNpm.length - 1]!);
  const lastChownAt = Math.max(...chownRoot);

  assert.ok(
    lastChownAt > lastNpmAt,
    `\`${DIRECTIVES[lastNpmAt]!.trim()}\` runs as root after the last chown of /root. It ` +
      'repopulates /root/.npm as root, so a cold `npm ci` as agent dies EACCES and no agent ' +
      'starts (#242).',
  );
  assert.ok(
    lastChownAt < userAt,
    `the chown of /root runs after \`USER agent\`: \`${DIRECTIVES[lastChownAt]!.trim()}\`. ` +
      'Chowning /root needs root, so the build would fail.',
  );
});
