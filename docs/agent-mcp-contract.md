# Kan-ductor Agent MCP Contract

This fork optimizes for Piotr + Iskra's operational loop:

capture -> clarify -> move -> audit -> explain.

It is not trying to become a generic MCP-complete project management API.

## First-Class Discovery Flow

An assistant must be able to start with no remembered Kan-ductor IDs:

1. `get_default_context`
2. `ensure_ai_inbox`
3. `create_ai_inbox_card`
4. `move_ai_inbox_card`
5. `get_recent_activity`

`workspacePublicId`, board IDs, and list IDs are allowed but should not be
required for the normal AI Inbox path. The token's scoped workspace is the
default.

## Direct Action Surface

Allowed direct action tools:

- `create_card`
- `create_ai_inbox_card`
- `move_card`
- `move_ai_inbox_card`
- `comment_card`

Everything broader stays proposal-first:

- bulk moves
- archive/delete
- board restructuring
- imports
- broad card updates with many fields

No delete tool should be exposed by default.

## AI Inbox Convenience Tools

`create_ai_inbox_card`:

- required: `title`
- optional: `columnName`, `description`, `dueDate`, `metadata`,
  `idempotencyKey`
- default column: `Captured`

`move_ai_inbox_card`:

- required: `toColumnName`
- one of: `cardPublicId` or `query`
- optional: `index`, `idempotencyKey`
- ambiguous title/query matches must return candidates without mutating

These tools exist because Piotr naturally says things like:

- "dodaj do AI Inbox"
- "wrzuc do Captured"
- "przesun do Doing"

## Time Contract

Operational timezone: `Europe/Warsaw`.

`get_recent_activity` accepts:

- `since`: ISO datetime with timezone offset, normalized to UTC
- `today: true`: start of the current `Europe/Warsaw` day

Examples:

- accepted: `2026-05-09T00:00:00+02:00`
- accepted: `2026-05-08T22:00:00.000Z`

If both `since` and `today` are provided, `since` wins.

## Activity And Audit Attribution

Kan-ductor's regular card activity may still have a technical user attached, but the
agent read path must not imply that Piotr manually moved a card when Iskra did.

`get_recent_activity.cardActivities[]` includes:

- `actorKind`: `human` or `agent`
- `displayActorName`: the user-facing actor
- `viaAgentTokenName`: agent token name when an agent action is inferred
- `agentAuditPublicId`: linked audit event when available
- `fromListPublicId` / `fromListName`
- `toListPublicId` / `toListName`

For `card.created`, `fromList*` should be `null` and `toList*` should identify
the initial column. This keeps the activity stream usable as the foundation for
later flow analytics without guessing a card's starting state from its current
column.

For Iskra actions, `displayActorName` should be `OpenClaw Iskra MCP`.

The audit log is canonical.

## Audit Guarantees

Every action-mode mutation must return or expose:

- `auditPublicId`
- `actor`
- `mode`
- `idempotencyKey`
- `result`
- `createdAt`

Every write must create an audit event. Idempotency replays must not duplicate
the write and must report `idempotentReplay: true`.

## Metadata Shape

Card metadata used by Iskra:

- `source`: `signal`, `fastmail`, `meeting`, `forgejo`, `manual`, `obsidian`,
  `iskra`, `n8n`
- `sourceRef`: for example `signal:+48508463453:<message_id>`
- `createdByKind`: `human`, `iskra`, `n8n`, `import`
- `sensitivity`: `normal`, `private`, `sensitive`
- `relationshipRef`
- `projectRef`
- `lastAiSummary`

`get_recent_activity` should support source/action/actor filters so Iskra can
answer:

- "co dzis przesunalem?"
- "co dzis zrobila Iskra?"
- "jakie karty powstaly z Signala?"

## Smoke Test

Run from a host allowed to reach Kan-ductor MCP, currently VPS1000:

```bash
KAN_MCP_URL=https://kan.pdurlej.com/mcp \
node scripts/kan-mcp-loop-smoke.mjs
```

Expected behavior:

- ensure AI Inbox
- create a Signal-like card in `Captured`
- replay create idempotently
- move it to `Doing`
- replay move idempotently
- read recent activity
- assert both card activity and agent audit exist
- assert the move activity is attributed to `OpenClaw Iskra MCP`

## Non-Goals

- autonomous prioritization
- silent card movement
- generic Trello/Jira completeness
- bulk mutation without preview
- memory replacement for Obsidian/vault
