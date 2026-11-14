# chat-mcp agent image — node, git, the gh CLI and the claude CLI (#129, #214).
# No docker-in-docker: privileged ops go through #133's host broker.
FROM node:22-slim

# 🛑 ca-certificates IS NOT OPTIONAL AND IS NOT ABOUT gh. The line below once
# installed `git` alone with --no-install-recommends, which is exactly what
# dropped the ca-certificates package `git` would otherwise have pulled in. So
# /etc/ssl/certs/ca-certificates.crt was absent and EVERY https route out of
# the container failed with "server certificate verification failed. CAfile:
# none" — before any credential was involved. Measured in the running
# chat-mcp-claude2 container on 2026-11-13 (#214).
#
# wget is here to fetch the gh keyring in the next layer, and that fetch is
# itself https — so it has to follow ca-certificates, not accompany it.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git wget \
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

RUN npm install -g @anthropic-ai/claude-code

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
RUN chown -R agent:agent /opt/chat-mcp

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
