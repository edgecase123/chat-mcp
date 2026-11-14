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
RUN mkdir -p -m 755 /etc/apt/keyrings \
  && wget -nv -O /etc/apt/keyrings/githubcli-archive-keyring.gpg \
       https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*

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

ENV HOME=/root
USER agent
