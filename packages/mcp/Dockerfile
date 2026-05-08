# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=20

FROM node:${NODE_VERSION}-alpine AS alpine
RUN apk update && \
    apk add --no-cache libc6-compat && \
    rm -rf /var/cache/apk/* /tmp/* || true && \
    corepack enable && \
    corepack prepare pnpm@9.14.2 --activate && \
    npm install turbo@2.3.1 --global && \
    pnpm config set store-dir ~/.pnpm-store

FROM alpine AS pruner
WORKDIR /app
COPY . .
RUN turbo prune --scope=@kan/mcp --docker

FROM alpine AS deps
WORKDIR /app
COPY --from=pruner /app/out/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=pruner /app/out/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=pruner /app/out/json/ .

ENV CI=true
RUN --mount=type=cache,id=pnpm,target=~/.pnpm-store pnpm install --frozen-lockfile

FROM alpine AS builder
WORKDIR /app
COPY --from=deps /app/ ./
COPY --from=pruner /app/out/full/ .

ENV CI=true
RUN pnpm build --filter=@kan/mcp

FROM node:${NODE_VERSION}-alpine AS mcp
WORKDIR /app

ENV NODE_ENV=production
ENV KAN_MCP_HOST=0.0.0.0
ENV KAN_MCP_PORT=8086

COPY --from=builder /app/ ./

EXPOSE 8086
CMD ["node", "--import", "tsx", "packages/mcp/src/index.ts"]
