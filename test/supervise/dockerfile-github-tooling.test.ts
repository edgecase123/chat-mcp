import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DOCKERFILE = readFileSync(join(process.cwd(), 'Dockerfile'), 'utf8');

/**
 * #214: a containerized agent could not reach GitHub by ANY route.
 *
 * 🛑 WHAT THESE TESTS DO AND DO NOT PROVE. They read the Dockerfile's bytes,
 * so they prove the install lines have not been deleted. They do NOT prove the
 * built image contains the binaries — only a real `docker build` does that,
 * and it is recorded in the PR body instead of run here, because the suite
 * must not need a docker daemon.
 */

/**
 * 🛑 THE PREREQUISITE, AND IT IS NOT ABOUT `gh`. `node:22-slim` installs `git`
 * with `--no-install-recommends`, which drops the `ca-certificates` package
 * `git` would otherwise pull in. So `/etc/ssl/certs/ca-certificates.crt` was
 * absent and HTTPS failed with `server certificate verification failed.
 * CAfile: none` before any credential was involved. Measured in the running
 * `chat-mcp-claude2` container on 2026-11-13.
 */
test('the image installs ca-certificates, without which HTTPS cannot work at all', () => {
  assert.match(DOCKERFILE, /ca-certificates/);
});

test('the image installs the gh CLI, so an agent can file a ticket or open a PR', () => {
  assert.match(DOCKERFILE, /\bgh\b/);
});

/**
 * The paired control for the `gh` test above. `gh` is not in Debian's own
 * repositories, so `apt-get install gh` alone resolves to nothing and the
 * build succeeds with no `gh` in the image. The keyring and source list are
 * what make the package reachable, and their absence is exactly the silent
 * pass this asserts against.
 */
test('the gh install configures GitHub own apt source, not just the package name', () => {
  assert.match(DOCKERFILE, /cli\.github\.com/);
});

/**
 * 🛑 NO SECRET IN THE IMAGE. The token is injected at `docker run` by name
 * (`dockerRunPlan`), never baked in. An `ENV GH_TOKEN=` or an `ARG` carrying
 * one would put the credential in every layer and in `docker history`.
 */
test('no GitHub credential is baked into the image', () => {
  assert.doesNotMatch(DOCKERFILE, /^\s*(ENV|ARG)\s+GH_TOKEN\s*=/m);
  assert.doesNotMatch(DOCKERFILE, /gh\s+auth\s+login/);
});
