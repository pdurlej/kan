# OpenClaw Kan MCP

This fork exposes Kan to Iskra/OpenClaw through a Streamable HTTP MCP server.
The MCP server is intentionally thin: it calls the Kan Integration REST API and
does not connect to Postgres.

## Runtime

Required environment for `kan-mcp`:

```env
KAN_BASE_URL=https://kan.pdurlej.com
KAN_AGENT_TOKEN=kan_agent_...
KAN_MCP_HOST=0.0.0.0
KAN_MCP_PORT=8086
KAN_MCP_ACTIONS_ENABLED=true
```

Optional:

```env
KAN_MCP_BEARER_TOKEN=...
```

Use `KAN_MCP_BEARER_TOKEN` only if the OpenClaw/mcporter client supports custom
authorization headers. Otherwise rely on the tailnet allowlist and keep the Kan
agent token only on RS2000 inside the MCP service environment.

## Tools

Read tools:

- `list_boards`
- `list_columns`
- `list_cards`
- `search_cards`
- `get_card_context`
- `get_recent_activity`

Action tools:

- `create_card`
- `move_card`
- `comment_card`

Proposal tools:

- `propose_board_update`
- `apply_approved_update`
- `ensure_ai_inbox`

`create_card`, `move_card`, `comment_card`, and `apply_approved_update` require
`KAN_MCP_ACTIONS_ENABLED=true` and matching Kan agent-token scopes.

## OpenClaw/mcporter placement

On VPS1000, check both runtime OpenClaw and mcporter config. The local kickoff
runbook notes these paths:

- `/run/user/1000/openclaw/openclaw.json`
- `/home/openclaw/.mcporter/mcporter.json`
- `/home/openclaw/.openclaw/workspace/config/mcporter.json`

The intended server entry is:

```json
{
  "kan": {
    "url": "https://kan.pdurlej.com/mcp"
  }
}
```

If mcporter supports per-server headers, add:

```json
{
  "kan": {
    "url": "https://kan.pdurlej.com/mcp",
    "headers": {
      "Authorization": "Bearer ${KAN_MCP_BEARER_TOKEN}"
    }
  }
}
```

Do not put the internal `KAN_AGENT_TOKEN` into the OpenClaw client config unless
there is no server-side MCP bridge. The preferred model is: OpenClaw gets the MCP
URL, `kan-mcp` holds the Kan REST token.

## Smoke Test

1. Call `ensure_ai_inbox` for the workspace.
2. Call `create_card` in the `Captured` column with an idempotency key.
3. Call `move_card` to move that card to `Doing`.
4. Call `get_recent_activity` with `onlyMoves=true`.

Expected result: the move appears in card activity and the action appears in
agent audit.
