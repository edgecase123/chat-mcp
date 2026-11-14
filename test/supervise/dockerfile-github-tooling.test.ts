import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DOCKERFILE = readFileSync(join(process.cwd(), 'Dockerfile'), 'utf8');

/**
 * 🛑 COMMENT LINES ARE STRIPPED, AND THAT IS THE WHOLE TEST. A first cut
 * matched the file's bytes, and the comments above these very install lines
 * NAME every string the assertions look for — so deleting both
 * `apt-get install` lines left all of them green. Measured, not supposed:
 * strip `ca-certificates` from one and `gh` from the other, and 4 of 4 passed.
 * claude1's own reviewer caught it before merge.
 *
 * Prose naming a package is not an install, so prose is not evidence.
 */
const INSTALLS = DOCKERFILE.split('\n')
  .filter((line) => !line.trimStart().startsWith('#'))
  .join('\n');

/**
 * 🛑 `\`-CONTINUED LINES ARE JOINED HERE, AND THAT IS WHAT THE CREDENTIAL
 * GUARD READS. A `^ENV` anchor only ever saw the FIRST variable on a line, so
 * `ENV FOO=1 GH_TOKEN=x` slipped past it, and a continuation could put the
 * variable on a line beginning with neither `ENV` nor `ARG`. Both measured.
 */
const LOGICAL_LINES = INSTALLS.replace(/\\\n\s*/g, ' ');

/**
 * #214: a containerized agent could not reach GitHub by ANY route.
 *
 * ⚠️ WHAT THESE PROVE AND DO NOT PROVE. They read the Dockerfile, so they
 * prove the install instructions have not been deleted. They do NOT prove the
 * BUILT IMAGE contains the binaries — only a real `docker build` does that,
 * and it is recorded in the PR body, because the suite must not need a docker
 * daemon.
 */

/**
 * 🛑 THE PREREQUISITE, AND IT IS NOT ABOUT `gh`. `node:22-slim` installed
 * `git` with `--no-install-recommends`, which is exactly what dropped the
 * `ca-certificates` package `git` would otherwise have pulled in. So
 * `/etc/ssl/certs/ca-certificates.crt` was absent and every https route out
 * failed with `server certificate verification failed. CAfile: none`, before
 * any credential was involved. Measured in the running `chat-mcp-claude2`
 * container on 2026-11-13.
 */
test('an apt-get install line installs ca-certificates, without which HTTPS cannot work at all', () => {
  assert.match(INSTALLS, /apt-get install[^\n]*\bca-certificates\b/);
});

test('an apt-get install line installs the gh CLI, so an agent can file a ticket or open a PR', () => {
  assert.match(INSTALLS, /apt-get install[^\n]*\bgh\b/);
});

/**
 * The paired control for the `gh` test above. `gh` is not in Debian's own
 * repositories, so `apt-get install gh` alone resolves to nothing and the
 * build SUCCEEDS with no `gh` in the image.
 *
 * 🛑 ONE REGEX SPANNING BOTH LINES, NOT TWO ASSERTS. A bare /cli\.github\.com/
 * also matched the keyring `wget` URL, so deleting the `deb` line — the line
 * that makes the package resolve at all — left this green. Measured.
 */
test('the gh install writes GitHub own apt source to the list apt reads', () => {
  assert.match(
    INSTALLS,
    /deb \[[^\]]*\] https:\/\/cli\.github\.com\/packages[^\n]*"[\s\\]*>[\s]*\/etc\/apt\/sources\.list\.d\/github-cli\.list/,
  );
});

/**
 * 🛑 NO SECRET IN THE IMAGE. The token is injected at `docker run` by name
 * (`dockerRunPlan`), never baked in. An `ENV GH_TOKEN=` or an `ARG` carrying
 * one would put the credential in every layer and in `docker history`.
 */
test('no GitHub credential is baked into the image', () => {
  // 🛑 BOTH NAMES. `gh` reads GITHUB_TOKEN as well as GH_TOKEN, and nothing
  // guarded the second one at all.
  // Anywhere on the directive, not just first, and no `=` required: all of
  // `ARG GH_TOKEN`, `ENV GH_TOKEN value` and `ENV FOO=1 GH_TOKEN=x` baked a
  // credential in and passed an earlier cut of this assertion.
  assert.doesNotMatch(LOGICAL_LINES, /^\s*(ENV|ARG)\b[^\n]*\b(GH|GITHUB)_TOKEN\b/m);
  assert.doesNotMatch(INSTALLS, /gh\s+auth\s+login/);
});

/**
 * 🛑 `git push` DOES NOT READ `GH_TOKEN` — only `gh` does. The ticket's "or
 * push" is satisfied by this credential helper, not by injecting the var, and
 * without the helper a push from inside the container fails even with a valid
 * token on file. The security reviewer caught the diff claiming otherwise.
 *
 * Baked in at build time because it carries no secret: it only tells git to
 * ask `gh`, which reads the token from the environment at run time.
 */
test('git is configured to get GitHub credentials from gh, so push works at all', () => {
  // 🛑 THE `!` IS LOAD-BEARING. Without it git resolves the value to the
  // binary `git-credential-gh`, which does not exist, and the push fails.
  // The host is pinned too: `https://github.co` passed the loose form.
  assert.match(
    INSTALLS,
    /git config --system credential\."https:\/\/github\.com"\.helper '!gh auth git-credential'/,
  );
});

/**
 * 🛑 PIN THE ROOT OF TRUST. Without a digest this is trust-on-first-use:
 * anyone able to forge a trusted certificate for cli.github.com substitutes
 * the keyring itself, and every later `signed-by` check then verifies happily
 * against their key.
 *
 * ⚠️ A ROTATION BREAKS THE BUILD, LOUDLY. That is the intended direction.
 */
test('the gh keyring is verified against a pinned digest, not trusted on first use', () => {
  assert.match(INSTALLS, /sha256sum -c/);
  assert.match(INSTALLS, /\b[0-9a-f]{64}\b/);
});
