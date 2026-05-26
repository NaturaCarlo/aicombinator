# Agent Container — Runs Claude Code SDK agents for a single company.
#
# Each company gets one container with:
# - Node.js runtime for Claude Code SDK
# - /workspace/ volume mount (shared filesystem for all agents)
# - MCP server sockets mounted from host
# - Non-root `node` user for security

FROM node:22-slim

# Install system dependencies for Claude Code and browser automation
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI globally
RUN npm install -g @anthropic-ai/claude-code

# Create workspace directory (will be volume-mounted)
RUN mkdir -p /workspace/.agent && chown -R node:node /workspace

# Run as non-root user
USER node

WORKDIR /workspace

# Keep container alive — supervisor wakes agents on demand
CMD ["sleep", "infinity"]
