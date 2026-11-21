# chat-mcp agent image — node, git, the gh CLI and one agent CLI (#129, #214, #317).
# No docker-in-docker: privileged ops go through #133's host broker.
#
# 🛑 TWO IMAGES, ONE TARGET, SELECTED BY A BUILD ARG. `--build-arg
# AGENT_VENDOR=cursor` swaps the vendor CLI and nothing else. There is no
# `--target claude` / `--target cursor`, and that is not a style choice: the
# shared tail below ends in `chown -R agent:agent /root`, which exists because a
# root-run `npm` repopulates `/root/.npm` AFTER the useradd chown (#242, 4 cold
# starts, 4 EACCES failures, 0 agents started). A per-vendor TARGET would have
# to sit either below that chown — re-breaking #242 — or above it, duplicating
# the 44-line tail. A dynamic `FROM` keeps one copy of both.
ARG AGENT_VENDOR=claude

FROM node:22-slim AS base

# 🛑 ca-certificates IS NOT OPTIONAL AND IS NOT ABOUT gh. The line below once
# installed `git` alone with --no-install-recommends, which is exactly what
# dropped the ca-certificates package `git` would otherwise have pulled in. So
# /etc/ssl/certs/ca-certificates.crt was absent and EVERY https route out of
# the container failed with "server certificate verification failed. CAfile:
# none" — before any credential was involved. Measured in the running
# chat-mcp-claude2 container on 2026-11-13 (#214).
#
# ⚠️ CURSOR NEEDS IT TOO, FOR THE SAME REASON. Its wrapper execs node with
# `--use-system-ca`, so the Cursor image depends on this line exactly as `gh`
# does. Read out of the wrapper script in the pinned tarball, 2026-11-21.
#
# wget is here to fetch the gh keyring in the next layer, and that fetch is
# itself https — so it has to follow ca-certificates, not accompany it.
#
# ⚠️ perl IS NAMED FOR `shasum`, WHICH THE INSTALL GUARD RUNS. It arrived only
# as a dependency of git, and the failure if it stopped arriving is silent: the
# hash comes back empty, the guard installs by design, and every cold spawn
# pays a full `npm ci` with nothing saying why.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git perl wget \
  && rm -rf /var/lib/apt/lists/*

# 🛑 GitHub's OWN apt SOURCE, NOT `apt-get install gh`. `gh` is not in Debian's
# repositories, so the bare package name resolves to nothing — and the build
# would SUCCEED with no gh in the image. The keyring and the source list are
# what make the package reachable at all.
#
# 🛑 THE KEYRING DIGEST IS PINNED, AND A ROTATION BREAKS THIS BUILD LOUDLY.
# That is the intended direction. Without the pin this is trust-on-first-use:
# anyone able to forge a trusted certificate for cli.github.com substitutes
# the ROOT of trust, and every later `signed-by` check then verifies happily
# against their key. Raised by the security reviewer on #214.
#
# ⚠️ WHEN THIS FAILS, DO NOT JUST REPLACE THE HASH. Fetch the keyring, verify
# it against GitHub's published fingerprint, and only then update this line.
# Digest observed 2026-11-13.
RUN mkdir -p -m 755 /etc/apt/keyrings \
  && wget -nv -O /etc/apt/keyrings/githubcli-archive-keyring.gpg \
       https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  && echo "6084d5d7bd8e288441e0e94fc6275570895da18e6751f70f057485dc2d1a811b  /etc/apt/keyrings/githubcli-archive-keyring.gpg" \
       | sha256sum -c - \
  && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*

# 🛑 `git push` DOES NOT READ `GH_TOKEN`. Only `gh` does. Plain git needs a
# credential helper, and this is the one `gh auth setup-git` installs — so the
# ticket's "or push" is satisfied by this line, not by injecting the var.
# Baked in at BUILD time because it carries no secret: it only tells git to
# ask `gh`, which reads the token from the environment at run time.
# --system, so it applies whatever HOME the agent user ends up with.
RUN git config --system credential."https://github.com".helper '!gh auth git-credential' \
  && git config --system credential."https://gist.github.com".helper '!gh auth git-credential'

# 🛑 WITHOUT THIS, EVERY GIT COMMAND IN A MOUNTED TREE FAILS (#212). A bind
# mount appears inside the container as `uid=0` while this process is
# `uid=10001`, so git refuses the repository as dubiously owned — status, log,
# commit and push alike. Reading and writing the same files works; only git
# refuses, which is why it stayed invisible until an agent said what it did.
#
# 🛑 `*`, NOT A LIST, AND lee RULED THAT ON 2026-11-14. An enumerated list
# cannot work from here: extra mounts come from `mounts.json` at RUN time, so
# build time does not know their `/mnt/<key>` paths and any fixed list is
# incomplete by construction. The check it widens guards one user against a repo
# ANOTHER user planted, and this container has a single tenant.
#
# 🛑 MUST STAY ABOVE `USER agent`. `--system` writes /etc/gitconfig and needs
# root. Pinned by dockerfile-safe-directory.test.ts, which asserts the order.
RUN git config --system --add safe.directory '*'

# ── vendor CLI stages ───────────────────────────────────────────────────────
# One stage per agent vendor. Exactly one is selected by `AGENT_VENDOR` in the
# `FROM` below, so the other is never built.

FROM base AS cli-claude

RUN npm install -g @anthropic-ai/claude-code

FROM base AS cli-cursor

# 🛑 THE ARTIFACT IS PINNED, NOT THE INSTALLER. Cursor documents
# `curl https://cursor.com/install -fsS | bash`, which is trust-on-first-use
# for whatever that script fetches today. The script resolves to this versioned
# tarball, so the image downloads the tarball and sha256sum -c's it — and no
# remote shell script runs at build time. Stronger than the `gh` keyring
# precedent above, which pins the key rather than the package.
#
# ⚠️ BOTH ARCHES ARE PINNED BECAUSE THERE IS NO `--platform` HERE. The image
# follows the build host. A single-arch hash would fail every build on the
# other architecture, so the `case` below resolves the pair together and exits
# 1 on anything else rather than installing nothing.
ARG CURSOR_VERSION=2026.11.19-f005e9d
ARG CURSOR_SHA256_ARM64=5ff05be0d7c0b7754574dbcd677c35254a3ff190ed6457e71bbee0f276237e29
ARG CURSOR_SHA256_AMD64=a25986eaf0c9330aeeec599a139711cb9f267c64562d073a72b751edf5161695

# 🛑 ROOT-OWNED, AND THAT IS THE WHOLE MITIGATION. `cursor-agent` checks for
# updates and there is no documented opt-out — all 226 CURSOR_*/AGENT_CLI_* vars
# in the bundle were scanned, and the two update-related ones only override the
# check URL and the reported version string. So a build-time pin describes
# nothing unless the agent user cannot rewrite the install. /opt/cursor-agent is
# outside every chown in the final stage, which is why it is not under /root.
#
# 🛑 `--no-same-owner`, SO A FUTURE TARBALL CANNOT HAND THE INSTALL TO `agent`.
# Every entry in the pinned tarball is uid/gid 0 today, but tar extracting as
# root honours the archive's uids by default — so a rebuild against a tarball
# built under uid 10001 would silently undo the paragraph above.
RUN set -eu; \
  arch="$(dpkg --print-architecture)"; \
  case "$arch" in \
    arm64) cursor_arch=arm64; cursor_sha="$CURSOR_SHA256_ARM64" ;; \
    amd64) cursor_arch=x64;   cursor_sha="$CURSOR_SHA256_AMD64" ;; \
    *) echo "no pinned cursor-agent tarball for architecture: $arch" >&2; exit 1 ;; \
  esac; \
  wget -nv -O /tmp/cursor-agent.tar.gz \
    "https://downloads.cursor.com/lab/${CURSOR_VERSION}/linux/${cursor_arch}/agent-cli-package.tar.gz"; \
  echo "${cursor_sha}  /tmp/cursor-agent.tar.gz" | sha256sum -c -; \
  mkdir -p /opt/cursor-agent; \
  tar -xzf /tmp/cursor-agent.tar.gz -C /opt/cursor-agent \
    --strip-components=1 --no-same-owner; \
  rm /tmp/cursor-agent.tar.gz; \
  ln -s /opt/cursor-agent/cursor-agent /usr/local/bin/cursor-agent

# ── shared tail ─────────────────────────────────────────────────────────────
# 🛑 EVERYTHING BELOW IS VENDOR-AGNOSTIC AND MUST STAY THAT WAY. A vendor-
# specific line here is a line that only one of the two images is tested with.

FROM cli-${AGENT_VENDOR} AS final

# 🛑 NON-ROOT, NOT OPTIONAL. `claude --allow-dangerously-skip-permissions`
# refuses to run as root/sudo — confirmed by actually running the image
# (#129 Task 9 smoke test; exit 1, "cannot be used with root/sudo
# privileges"). HOME stays /root (not /home/agent) so CONTAINER_STATE_DIR
# in docker-claude.ts keeps resolving to /root/.chat-mcp with no code
# change — chown it to the new user instead of relocating it.
RUN useradd --create-home --uid 10001 agent \
  && chown -R agent:agent /root

WORKDIR /opt/chat-mcp
COPY package.json package-lock.json ./
# 🛑 --ignore-scripts, NOT JUST --omit=dev. `npm ci` always fires the
# `prepare` lifecycle script regardless of --omit, and `prepare` here is
# `npm run build` (tsc) — but tsc is a devDependency, omitted by the flag
# above. Without --ignore-scripts the build fails with "tsc: not found".
# Verified by actually building this image (#129 Task 9).
RUN npm ci --omit=dev --ignore-scripts
# Prebuilt on the HOST before `docker build` runs — see container.ts's
# buildImage(), which runs `npm run build` first. This image never runs tsc.
COPY dist ./dist

# 🛑 `/root` IS RE-CHOWNED HERE, NOT ONLY AT THE `useradd`. The `npm ci` above
# runs as root with HOME=/root, so it repopulates `/root/.npm/_cacache` AFTER
# the chown beside `useradd` — leaving 1073 root-owned paths in a cache the
# agent then has to write. A cold `npm ci` as `agent` died `EACCES: mkdir
# /root/.npm/_cacache/...`, the prelude chains on `&&`, and NO AGENT STARTED.
# Measured 4 times on a fresh volume: 4 failures, 0 agents. #242.
#
# ⚠️ IT IS THE ORDER THAT BREAKS, NOT THE CHOWN. Moving either line is enough;
# both are chowned here so no later root-run layer can reintroduce it without
# also moving past this point.
#
# ⚠️ THE VENDOR STAGE'S ROOT-RUN npm IS COVERED BY THIS TOO. `cli-claude` runs
# `npm install -g` as root with HOME=/root, and this chown is downstream of it
# in build order as well as in the file.
#
# Rejected: pointing `npm_config_cache` at a writable path. It leaves the
# root-owned files in the image and trades a hard failure for a cold cache on
# every single spawn.
RUN chown -R agent:agent /opt/chat-mcp /root

# 🛑 MUST STAY ABOVE `USER agent`, AND THE OWNERSHIP IS THE POINT. The driver
# mounts a container-owned `node_modules` as a NAMED VOLUME here, and docker
# seeds a new volume's contents and ownership from the image's directory at the
# destination. With nothing at this path the volume root is root:root, `npm ci`
# fails EACCES as agent, and the prelude's `&&` chain means no agent starts.
# Pinned by dockerfile-node-modules-ownership.test.ts, which asserts the order.
#
# Rejected: chowning from the prelude at runtime. The prelude already runs as
# agent, so it cannot, and running it as root would undo the non-root guarantee.
RUN mkdir -p /work/node_modules && chown -R agent:agent /work

ENV HOME=/root
USER agent
