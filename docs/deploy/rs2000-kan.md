# RS2000 Kan Deployment

Target:

- Public name: `kan.pdurlej.com`
- Tailscale RS2000 address: `100.110.188.20`
- OpenClaw/VPS1000 Tailscale address: `100.79.239.52`
- Web image: `ghcr.io/pdurlej/kan:rs2000`
- Migration image: `ghcr.io/pdurlej/kan-migrate:rs2000`
- MCP image: `ghcr.io/pdurlej/kan-mcp:rs2000`

## DNS and edge

`kan.pdurlej.com` should resolve inside the tailnet to RS2000 only:

```dns
kan IN A 100.110.188.20
```

Traefik should expose:

- `Host(kan.pdurlej.com)` -> `kan-web:3000`
- `Host(kan.pdurlej.com) && PathPrefix(/mcp)` -> `kan-mcp:8086`

The web route should use the existing tailnet allowlist. The MCP route should be
tighter: allow VPS1000 `100.79.239.52/32` plus Piotr's debugging devices only.

## Services

Expected compose services in the RS2000 infra repo:

- `kan-postgres`: private Postgres with its own volume.
- `kan-migrate`: run-once migration container using the `kan-migrate` image.
- `kan-web`: Next.js Kan app.
- `kan-mcp`: Streamable HTTP MCP bridge.

Expected networks:

- `internal`: Postgres, migrate, web, MCP.
- `proxy`: web and MCP to Traefik.

## Required environment

```env
KAN_HOSTNAME=kan.pdurlej.com
KAN_POSTGRES_PASSWORD=...
POSTGRES_URL=postgres://kan:${KAN_POSTGRES_PASSWORD}@kan-postgres:5432/kan
BETTER_AUTH_SECRET=...
NEXT_PUBLIC_BASE_URL=https://kan.pdurlej.com
KAN_BASE_URL=https://kan.pdurlej.com
KAN_AGENT_TOKEN=kan_agent_...
KAN_MCP_ACTIONS_ENABLED=true
```

Secrets should be rendered through the existing Infisical/env flow. Do not commit
plaintext secrets to the infra repo.

## Rollback

Use immutable image tags when promoting:

- `ghcr.io/pdurlej/kan:sha-<shortsha>`
- `ghcr.io/pdurlej/kan-migrate:sha-<shortsha>`
- `ghcr.io/pdurlej/kan-mcp:sha-<shortsha>`

Rollback is switching `KAN_IMAGE_TAG` or equivalent infra variable back to the
previous known-good SHA tag and restarting only Kan services.

## Acceptance

- `docker compose config` passes on RS2000.
- `kan-migrate` exits zero.
- `kan-web` health/page loads from a tailnet client.
- Public internet clients cannot reach `kan.pdurlej.com`.
- `kan-mcp` `/health` is available behind Traefik from allowed tailnet clients.
- OpenClaw can call `create_card`, `move_card`, and `get_recent_activity` through
  `https://kan.pdurlej.com/mcp`.
