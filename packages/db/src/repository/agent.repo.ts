import { createHash, randomBytes } from "crypto";
import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { dbClient } from "@kan/db/client";
import type {
  AgentApprovalState,
  AgentCreatedByKind,
  AgentProposalStatus,
  AgentSensitivity,
  AgentSource,
} from "@kan/db/schema";
import {
  agentAuditEvents,
  agentCardMetadata,
  agentProposals,
  agentTokens,
  boards,
  cardActivities,
  cards,
  lists,
  users,
  workspaces,
} from "@kan/db/schema";
import { generateUID } from "@kan/shared/utils";

export const allAgentScopes = [
  "boards:read",
  "columns:read",
  "cards:read",
  "activity:read",
  "cards:create",
  "cards:move",
  "comments:create",
  "proposals:create",
  "proposals:apply",
  "inbox:manage",
] as const;

export type AgentScope = (typeof allAgentScopes)[number];

export type AgentTokenRecord = Awaited<ReturnType<typeof getTokenBySecret>>;

const fromList = alias(lists, "from_list");
const toList = alias(lists, "to_list");

export const hashAgentToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");

export const parseAgentScopes = (scopes: string): AgentScope[] => {
  try {
    const parsed = JSON.parse(scopes) as unknown;
    if (!Array.isArray(parsed)) return [];

    return parsed.filter((scope): scope is AgentScope =>
      allAgentScopes.includes(scope as AgentScope),
    );
  } catch {
    return [];
  }
};

const jsonStringify = (value: unknown) =>
  value === undefined ? null : JSON.stringify(value);

const jsonParse = <T>(value: string | null): T | null => {
  if (!value) return null;

  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
};

export const createToken = async (
  db: dbClient,
  input: {
    name: string;
    workspaceId: number;
    boardId?: number | null;
    scopes: AgentScope[];
    createdBy: string;
    expiresAt?: Date | null;
  },
) => {
  const secret = `kan_agent_${randomBytes(32).toString("base64url")}`;
  const [result] = await db
    .insert(agentTokens)
    .values({
      publicId: generateUID(),
      name: input.name,
      tokenHash: hashAgentToken(secret),
      scopes: JSON.stringify(input.scopes),
      workspaceId: input.workspaceId,
      boardId: input.boardId ?? null,
      createdBy: input.createdBy,
      expiresAt: input.expiresAt ?? null,
    })
    .returning({
      publicId: agentTokens.publicId,
      name: agentTokens.name,
      scopes: agentTokens.scopes,
      workspaceId: agentTokens.workspaceId,
      boardId: agentTokens.boardId,
      expiresAt: agentTokens.expiresAt,
    });

  if (!result) throw new Error("Unable to create agent token");

  return {
    ...result,
    scopes: parseAgentScopes(result.scopes),
    token: secret,
  };
};

export const getTokenBySecret = async (db: dbClient, token: string) => {
  const tokenHash = hashAgentToken(token);

  const result = await db.query.agentTokens.findFirst({
    columns: {
      id: true,
      publicId: true,
      name: true,
      scopes: true,
      workspaceId: true,
      boardId: true,
      active: true,
      createdBy: true,
      expiresAt: true,
    },
    with: {
      workspace: {
        columns: {
          publicId: true,
          name: true,
        },
      },
      board: {
        columns: {
          publicId: true,
          name: true,
        },
      },
    },
    where: eq(agentTokens.tokenHash, tokenHash),
  });

  if (!result) return null;

  return {
    ...result,
    scopes: parseAgentScopes(result.scopes),
  };
};

export const touchToken = async (db: dbClient, tokenId: number) => {
  await db
    .update(agentTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(agentTokens.id, tokenId));
};

export const findAuditByIdempotencyKey = async (
  db: dbClient,
  input: {
    tokenId: number;
    action: string;
    idempotencyKey?: string | null;
  },
) => {
  if (!input.idempotencyKey) return null;

  const audit = await db.query.agentAuditEvents.findFirst({
    columns: {
      publicId: true,
      action: true,
      mode: true,
      actor: true,
      idempotencyKey: true,
      result: true,
      createdAt: true,
    },
    where: and(
      eq(agentAuditEvents.tokenId, input.tokenId),
      eq(agentAuditEvents.action, input.action),
      eq(agentAuditEvents.idempotencyKey, input.idempotencyKey),
    ),
  });

  if (!audit) return null;

  return {
    ...audit,
    result: jsonParse<unknown>(audit.result),
  };
};

export const createAuditEvent = async (
  db: dbClient,
  input: {
    tokenId?: number | null;
    workspaceId: number;
    boardId?: number | null;
    cardId?: number | null;
    action: string;
    mode: "read" | "proposal" | "action" | "setup";
    actor: string;
    requestId?: string | null;
    idempotencyKey?: string | null;
    input?: unknown;
    result?: unknown;
  },
) => {
  const [result] = await db
    .insert(agentAuditEvents)
    .values({
      publicId: generateUID(),
      tokenId: input.tokenId ?? null,
      workspaceId: input.workspaceId,
      boardId: input.boardId ?? null,
      cardId: input.cardId ?? null,
      action: input.action,
      mode: input.mode,
      actor: input.actor,
      requestId: input.requestId ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
      input: jsonStringify(input.input),
      result: jsonStringify(input.result),
    })
    .returning({
      publicId: agentAuditEvents.publicId,
      createdAt: agentAuditEvents.createdAt,
    });

  return result;
};

export const createProposal = async (
  db: dbClient,
  input: {
    tokenId?: number | null;
    workspaceId: number;
    boardId?: number | null;
    title: string;
    summary?: string | null;
    actions: unknown[];
    createdBy: string;
  },
) => {
  const [proposal] = await db
    .insert(agentProposals)
    .values({
      publicId: generateUID(),
      tokenId: input.tokenId ?? null,
      workspaceId: input.workspaceId,
      boardId: input.boardId ?? null,
      title: input.title,
      summary: input.summary ?? null,
      actions: JSON.stringify(input.actions),
      createdBy: input.createdBy,
    })
    .returning({
      publicId: agentProposals.publicId,
      title: agentProposals.title,
      status: agentProposals.status,
      createdAt: agentProposals.createdAt,
    });

  if (!proposal) throw new Error("Unable to create agent proposal");

  return proposal;
};

export const getProposalByPublicId = async (
  db: dbClient,
  proposalPublicId: string,
) => {
  const proposal = await db.query.agentProposals.findFirst({
    columns: {
      id: true,
      publicId: true,
      tokenId: true,
      workspaceId: true,
      boardId: true,
      title: true,
      summary: true,
      actions: true,
      status: true,
      createdBy: true,
      createdAt: true,
      decidedAt: true,
      appliedAt: true,
    },
    with: {
      workspace: {
        columns: {
          publicId: true,
        },
      },
      board: {
        columns: {
          publicId: true,
        },
      },
    },
    where: eq(agentProposals.publicId, proposalPublicId),
  });

  if (!proposal) return null;

  return {
    ...proposal,
    actions: jsonParse<unknown[]>(proposal.actions) ?? [],
  };
};

export const updateProposalStatus = async (
  db: dbClient,
  input: {
    proposalPublicId: string;
    status: AgentProposalStatus;
    decidedBy?: string | null;
    appliedAt?: Date | null;
  },
) => {
  const now = new Date();
  const [proposal] = await db
    .update(agentProposals)
    .set({
      status: input.status,
      decidedBy: input.decidedBy ?? undefined,
      decidedAt:
        input.status === "approved" || input.status === "rejected"
          ? now
          : undefined,
      appliedAt: input.appliedAt ?? undefined,
    })
    .where(eq(agentProposals.publicId, input.proposalPublicId))
    .returning({
      publicId: agentProposals.publicId,
      status: agentProposals.status,
    });

  return proposal;
};

export const upsertCardMetadata = async (
  db: dbClient,
  input: {
    cardId: number;
    source?: AgentSource | null;
    sourceRef?: string | null;
    createdByKind?: AgentCreatedByKind | null;
    approvalState?: AgentApprovalState;
    sensitivity?: AgentSensitivity;
    relationshipRef?: string | null;
    projectRef?: string | null;
    lastAiSummary?: string | null;
  },
) => {
  const values = {
    publicId: generateUID(),
    cardId: input.cardId,
    source: input.source ?? null,
    sourceRef: input.sourceRef ?? null,
    createdByKind: input.createdByKind ?? null,
    approvalState: input.approvalState ?? "applied",
    sensitivity: input.sensitivity ?? "normal",
    relationshipRef: input.relationshipRef ?? null,
    projectRef: input.projectRef ?? null,
    lastAiSummary: input.lastAiSummary ?? null,
    updatedAt: new Date(),
  };

  const [metadata] = await db
    .insert(agentCardMetadata)
    .values(values)
    .onConflictDoUpdate({
      target: agentCardMetadata.cardId,
      set: {
        source: values.source,
        sourceRef: values.sourceRef,
        createdByKind: values.createdByKind,
        approvalState: values.approvalState,
        sensitivity: values.sensitivity,
        relationshipRef: values.relationshipRef,
        projectRef: values.projectRef,
        lastAiSummary: values.lastAiSummary,
        updatedAt: values.updatedAt,
      },
    })
    .returning({
      publicId: agentCardMetadata.publicId,
      approvalState: agentCardMetadata.approvalState,
    });

  return metadata;
};

export const getRecentCardActivity = async (
  db: dbClient,
  input: {
    workspaceId: number;
    boardId?: number | null;
    since?: Date;
    limit?: number;
    onlyMoves?: boolean;
    actor?: string;
    action?: string;
    source?: AgentSource;
  },
) => {
  const limit = input.limit ?? 20;
  const actorQuery = input.actor?.trim().toLowerCase();
  const cardActivityAction =
    input.action === "move_card"
      ? eq(cardActivities.type, "card.updated.list")
      : input.action
        ? sql`false`
        : undefined;

  return db
    .select({
      publicId: cardActivities.publicId,
      type: cardActivities.type,
      createdAt: cardActivities.createdAt,
      cardPublicId: cards.publicId,
      cardTitle: cards.title,
      boardPublicId: boards.publicId,
      boardName: boards.name,
      fromListPublicId: fromList.publicId,
      fromListName: fromList.name,
      toListPublicId: toList.publicId,
      toListName: toList.name,
      actorUserId: users.id,
      actorName: users.name,
      actorEmail: users.email,
      source: agentCardMetadata.source,
      sourceRef: agentCardMetadata.sourceRef,
      createdByKind: agentCardMetadata.createdByKind,
      sensitivity: agentCardMetadata.sensitivity,
    })
    .from(cardActivities)
    .innerJoin(cards, eq(cardActivities.cardId, cards.id))
    .innerJoin(lists, eq(cards.listId, lists.id))
    .innerJoin(boards, eq(lists.boardId, boards.id))
    .leftJoin(agentCardMetadata, eq(agentCardMetadata.cardId, cards.id))
    .leftJoin(fromList, eq(cardActivities.fromListId, fromList.id))
    .leftJoin(toList, eq(cardActivities.toListId, toList.id))
    .leftJoin(users, eq(cardActivities.createdBy, users.id))
    .where(
      and(
        eq(boards.workspaceId, input.workspaceId),
        input.boardId ? eq(boards.id, input.boardId) : undefined,
        input.since ? gte(cardActivities.createdAt, input.since) : undefined,
        input.onlyMoves
          ? eq(cardActivities.type, "card.updated.list")
          : undefined,
        cardActivityAction,
        actorQuery
          ? sql`(lower(coalesce(${users.name}, '')) like ${`%${actorQuery}%`} or lower(coalesce(${users.email}, '')) like ${`%${actorQuery}%`})`
          : undefined,
        input.source ? eq(agentCardMetadata.source, input.source) : undefined,
        isNull(cards.deletedAt),
        isNull(lists.deletedAt),
        isNull(boards.deletedAt),
      ),
    )
    .orderBy(desc(cardActivities.createdAt))
    .limit(limit);
};

export const getRecentAgentAudit = async (
  db: dbClient,
  input: {
    workspaceId: number;
    boardId?: number | null;
    since?: Date;
    limit?: number;
    actor?: string;
    action?: string;
    source?: AgentSource;
  },
) => {
  const limit = input.limit ?? 20;
  const actorQuery = input.actor?.trim().toLowerCase();

  const rows = await db
    .select({
      publicId: agentAuditEvents.publicId,
      action: agentAuditEvents.action,
      mode: agentAuditEvents.mode,
      actor: agentAuditEvents.actor,
      idempotencyKey: agentAuditEvents.idempotencyKey,
      input: agentAuditEvents.input,
      result: agentAuditEvents.result,
      createdAt: agentAuditEvents.createdAt,
      cardPublicId: cards.publicId,
      cardTitle: cards.title,
      source: agentCardMetadata.source,
      sourceRef: agentCardMetadata.sourceRef,
      createdByKind: agentCardMetadata.createdByKind,
      sensitivity: agentCardMetadata.sensitivity,
    })
    .from(agentAuditEvents)
    .leftJoin(cards, eq(agentAuditEvents.cardId, cards.id))
    .leftJoin(agentCardMetadata, eq(agentCardMetadata.cardId, cards.id))
    .where(
      and(
        eq(agentAuditEvents.workspaceId, input.workspaceId),
        input.boardId ? eq(agentAuditEvents.boardId, input.boardId) : undefined,
        input.since ? gte(agentAuditEvents.createdAt, input.since) : undefined,
        input.action ? eq(agentAuditEvents.action, input.action) : undefined,
        actorQuery
          ? sql`lower(${agentAuditEvents.actor}) like ${`%${actorQuery}%`}`
          : undefined,
        input.source ? eq(agentCardMetadata.source, input.source) : undefined,
      ),
    )
    .orderBy(desc(agentAuditEvents.createdAt))
    .limit(limit);

  return rows.map((row) => ({
    ...row,
    input: jsonParse<unknown>(row.input),
    result: jsonParse<unknown>(row.result),
  }));
};

export const findBoardByName = async (
  db: dbClient,
  input: {
    workspaceId: number;
    name: string;
  },
) => {
  return db.query.boards.findFirst({
    columns: {
      id: true,
      publicId: true,
      name: true,
      slug: true,
    },
    with: {
      lists: {
        columns: {
          publicId: true,
          name: true,
          index: true,
        },
        where: isNull(lists.deletedAt),
      },
    },
    where: and(
      eq(boards.workspaceId, input.workspaceId),
      sql`lower(${boards.name}) = lower(${input.name})`,
      isNull(boards.deletedAt),
    ),
  });
};
