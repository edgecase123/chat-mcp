# chat-mcp agent image — node + git + the claude CLI, nothing else (#129).
# No docker-in-docker: privileged ops go through #133's host broker.
FROM node:22-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code

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
