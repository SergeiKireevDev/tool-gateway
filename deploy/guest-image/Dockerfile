# Agent VM root filesystem: Node 22, the agent CLIs, and the launchpad runner.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl iproute2 tini git ripgrep jq python3 procps less \
 && rm -rf /var/lib/apt/lists/*

ARG CLAUDE_CODE_VERSION=latest
ARG CODEX_VERSION=latest
ARG GEMINI_CLI_VERSION=latest
ARG PI_VERSION=latest
RUN npm install -g --no-audit --no-fund \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
      "@openai/codex@${CODEX_VERSION}" \
      "@google/gemini-cli@${GEMINI_CLI_VERSION}" \
      "@earendil-works/pi-coding-agent@${PI_VERSION}" \
 && npm cache clean --force

# The agent runs unprivileged; the runner (root) reads the config drive and owns the reporting.
RUN useradd -m -u 1001 -s /bin/bash agent
COPY guest/dist/ /opt/launchpad/
COPY deploy/guest-image/launchpad-init /sbin/launchpad-init
RUN chmod 0755 /sbin/launchpad-init && chmod -R a+rX /opt/launchpad
