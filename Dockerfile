# One image for both services: Node for the agent and web app, plus uv so the agent
# can start Python/uvx-packaged MCP servers (mcp-grafana, opensearch-mcp-server-py).
FROM node:24-slim
# The LiveKit native SDK needs the system root CAs to reach LiveKit Cloud over TLS.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:0.9.30 /uv /uvx /usr/local/bin/
RUN corepack enable
# The MCP servers mcp.json starts, installed as commands so a call doesn't wait on uvx.
ENV PATH="/root/.local/bin:$PATH"
RUN uv tool install mcp-grafana && uv tool install opensearch-mcp-server-py
WORKDIR /app
COPY . .
RUN corepack install && pnpm install --frozen-lockfile
RUN pnpm --filter @vic/web build
