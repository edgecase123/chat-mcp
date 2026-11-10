# chat-mcp agent image — node + git + the claude CLI, nothing else (#129).
# No docker-in-docker: privileged ops go through #133's host broker.
FROM node:22-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git \
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
