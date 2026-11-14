import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * #212: a containerized agent could not run ANY git command in the repo it was
 * given. The bind mount appears inside the container as `uid=0` while the
 * process is `uid=10001(agent)`, so git refused the repository.
 *
 * 🛑 lee RULED `safe.directory = *` ON 2026-11-14, over an enumerated list.
 * Enumeration cannot work from the Dockerfile: extra mounts come from
 * `mounts.json` at RUNTIME, so build time does not know their `/mnt/<key>`
 * paths and any fixed list is incomplete by construction. Do not "tighten"
 * this to a list — narrow it in the SUPERVISOR instead, which knows the mounts.
 *
 * ⚠️ WHAT THESE PROVE. They read the Dockerfile, so they prove the instruction
 * has not been deleted or reordered. They do NOT prove the built image behaves
 * — only a real `docker build` plus a `git` call inside it does that, and that
 * is recorded in the PR body, because the suite must not need a docker daemon.
 */

const DOCKERFILE = readFileSync(join(process.cwd(), 'Dockerfile'), 'utf8');

/**
 * 🛑 COMMENTS STRIPPED FIRST. The comment above the real instruction names
 * every string these assertions look for, so matching the file's raw bytes
 * would pass with the instruction deleted. That exact vacuity shipped once on
 * this same Dockerfile — see `dockerfile-github-tooling.test.ts`.
 */
const LINES = DOCKERFILE.split('\n').filter((l) => !l.trimStart().startsWith('#'));

/** `\`-continuations joined, so a directive split across lines is one string. */
const LOGICAL = LINES.join('\n').replace(/\\\n\s*/g, ' ');

test('🛑 the image trusts every directory for git, which is what lets an agent commit', () => {
  assert.match(
    LOGICAL,
    /git\s+config\s+--system\s+(--add\s+)?safe\.directory\s+['"]?\*['"]?/,
    'without this, every git command in /work fails: dubious ownership',
  );
});

/**
 * 🛑 THE ORDERING IS THE GUARD, NOT THE PRESENCE. `git config --system` writes
 * `/etc/gitconfig`, which needs root. Placed after `USER agent` the instruction
 * is still present, still looks right in review, and the BUILD FAILS — or
 * worse, writes nothing useful. A reader reordering the Dockerfile has no other
 * signal that this line is position-dependent.
 */
test('🛑 it is set BEFORE `USER agent`, because --system needs root', () => {
  const safeAt = LINES.findIndex((l) => /safe\.directory/.test(l));
  const userAt = LINES.findIndex((l) => /^\s*USER\s+agent\b/.test(l));

  assert.notEqual(safeAt, -1, 'no safe.directory instruction found at all');
  assert.notEqual(userAt, -1, 'no `USER agent` line found — has the image stopped dropping root?');
  assert.ok(
    safeAt < userAt,
    `safe.directory is at line ${safeAt + 1} and USER agent at ${userAt + 1}; --system cannot be written as a non-root user`,
  );
});

/**
 * ⚠️ CONTROL, AND IT IS NOT DECORATION. The image must still drop root. A fix
 * for #212 that ran the agent as root would make git work and silently undo the
 * thing the container is for.
 */
test('⚠️ control — the image still drops to a non-root user', () => {
  assert.match(LOGICAL, /^\s*USER\s+agent\b/m, 'the agent must not run as root');
  assert.doesNotMatch(
    LOGICAL.split('USER agent')[1] ?? '',
    /^\s*USER\s+root\b/m,
    'nothing may switch back to root after dropping privileges',
  );
});
