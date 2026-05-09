# ADR 0001: Agent Integration Surface

Date: 2026-05-08

## Status

Accepted for the Piotr + Iskra fork.

## Context

Upstream Kan is moving slowly at the release level. The latest release checked on
2026-05-08 is `v0.5.6`, a pre-release from 2026-03-19. Several useful PRs are
open but not merged:

- [#485 MCP server](https://github.com/kanbn/kan/pull/485): useful naming and
  tool surface reference, but too broad for this fork because it exposes general
  CRUD/delete behavior and stdio-first assumptions.
- [#486 websocket integration](https://github.com/kanbn/kan/pull/486): useful
  later, currently conflicting.
- [#481 calendar/due date](https://github.com/kanbn/kan/pull/481): adjacent to
  follow-up work, not required for the first agent loop.
- [#420 archive/trash](https://github.com/kanbn/kan/pull/420): aligned with the
  "no delete by default" direction, but currently not a clean drop-in.

Kan-ductor needs a narrow operational board for a human and an AI assistant. The
AI must be able to read, propose, and perform a few explicitly approved actions
without becoming an autonomous project manager.

## Decision

Kan-ductor keeps REST/OpenAPI as the stable integration boundary. MCP is a tool facade
that calls the REST Integration API and never talks to the database directly.

The integration surface is split into three paths:

- Read: list boards, columns, cards, card context, and recent activity.
- Proposal: store dry-run board updates for human approval.
- Action: create card, move card, and comment card through scoped tokens only.

Machine access uses a dedicated `agent_token` table instead of broad Better Auth
API keys. Tokens are scoped to a workspace, optionally to one board, and to an
explicit list of capabilities. Every write creates an `agent_audit_event` and a
normal Kan-ductor card activity where relevant.

Deletes and bulk mutations are intentionally absent from the first surface.

## Consequences

Iskra/OpenClaw can answer operational questions like "what moved today?" from
the normal activity log and "what did Iskra change?" from the agent audit log.

The MCP server can be deployed behind the tailnet and reverse proxy without
expanding the web app's UI router or giving the MCP process database access.

Future UI work can add accept/reject screens for proposals on top of the same
`agent_proposal` table without changing the MCP contract.
