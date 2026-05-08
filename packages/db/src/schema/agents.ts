import { relations, sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { boards } from "./boards";
import { cards } from "./cards";
import { users } from "./users";
import { workspaces } from "./workspaces";

export const agentProposalStatuses = [
  "proposed",
  "approved",
  "applied",
  "rejected",
] as const;
export type AgentProposalStatus = (typeof agentProposalStatuses)[number];
export const agentProposalStatusEnum = pgEnum(
  "agent_proposal_status",
  agentProposalStatuses,
);

export const agentApprovalStates = [
  "draft",
  "proposed",
  "approved",
  "applied",
  "rejected",
] as const;
export type AgentApprovalState = (typeof agentApprovalStates)[number];
export const agentApprovalStateEnum = pgEnum(
  "agent_approval_state",
  agentApprovalStates,
);

export const agentSources = [
  "signal",
  "fastmail",
  "meeting",
  "forgejo",
  "manual",
  "obsidian",
  "iskra",
  "n8n",
] as const;
export type AgentSource = (typeof agentSources)[number];
export const agentSourceEnum = pgEnum("agent_source", agentSources);

export const agentCreatedByKinds = ["human", "iskra", "n8n", "import"] as const;
export type AgentCreatedByKind = (typeof agentCreatedByKinds)[number];
export const agentCreatedByKindEnum = pgEnum(
  "agent_created_by_kind",
  agentCreatedByKinds,
);

export const agentSensitivityLevels = [
  "normal",
  "private",
  "sensitive",
] as const;
export type AgentSensitivity = (typeof agentSensitivityLevels)[number];
export const agentSensitivityEnum = pgEnum(
  "agent_sensitivity",
  agentSensitivityLevels,
);

export const agentTokens = pgTable(
  "agent_token",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    publicId: varchar("publicId", { length: 12 }).notNull().unique(),
    name: varchar("name", { length: 255 }).notNull(),
    tokenHash: text("tokenHash").notNull().unique(),
    scopes: text("scopes").notNull(),
    workspaceId: bigint("workspaceId", { mode: "number" })
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    boardId: bigint("boardId", { mode: "number" }).references(() => boards.id, {
      onDelete: "cascade",
    }),
    active: boolean("active").notNull().default(true),
    createdBy: uuid("createdBy")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt"),
    lastUsedAt: timestamp("lastUsedAt"),
    expiresAt: timestamp("expiresAt"),
  },
  (table) => [
    index("agent_token_workspace_idx").on(table.workspaceId),
    index("agent_token_board_idx").on(table.boardId),
    index("agent_token_active_idx").on(table.active),
  ],
).enableRLS();

export const agentAuditEvents = pgTable(
  "agent_audit_event",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    publicId: varchar("publicId", { length: 12 }).notNull().unique(),
    tokenId: bigint("tokenId", { mode: "number" }).references(
      () => agentTokens.id,
      { onDelete: "set null" },
    ),
    workspaceId: bigint("workspaceId", { mode: "number" })
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    boardId: bigint("boardId", { mode: "number" }).references(() => boards.id, {
      onDelete: "set null",
    }),
    cardId: bigint("cardId", { mode: "number" }).references(() => cards.id, {
      onDelete: "set null",
    }),
    action: varchar("action", { length: 100 }).notNull(),
    mode: varchar("mode", { length: 40 }).notNull(),
    actor: varchar("actor", { length: 255 }).notNull(),
    requestId: text("requestId"),
    idempotencyKey: text("idempotencyKey"),
    input: text("input"),
    result: text("result"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => [
    index("agent_audit_workspace_idx").on(table.workspaceId),
    index("agent_audit_board_idx").on(table.boardId),
    index("agent_audit_card_idx").on(table.cardId),
    index("agent_audit_created_at_idx").on(table.createdAt),
    uniqueIndex("agent_audit_idempotency_idx")
      .on(table.tokenId, table.action, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} IS NOT NULL`),
  ],
).enableRLS();

export const agentProposals = pgTable(
  "agent_proposal",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    publicId: varchar("publicId", { length: 12 }).notNull().unique(),
    tokenId: bigint("tokenId", { mode: "number" }).references(
      () => agentTokens.id,
      { onDelete: "set null" },
    ),
    workspaceId: bigint("workspaceId", { mode: "number" })
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    boardId: bigint("boardId", { mode: "number" }).references(() => boards.id, {
      onDelete: "cascade",
    }),
    title: varchar("title", { length: 255 }).notNull(),
    summary: text("summary"),
    actions: text("actions").notNull(),
    status: agentProposalStatusEnum("status").notNull().default("proposed"),
    createdBy: varchar("createdBy", { length: 255 }).notNull(),
    decidedBy: uuid("decidedBy").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    decidedAt: timestamp("decidedAt"),
    appliedAt: timestamp("appliedAt"),
  },
  (table) => [
    index("agent_proposal_workspace_idx").on(table.workspaceId),
    index("agent_proposal_board_idx").on(table.boardId),
    index("agent_proposal_status_idx").on(table.status),
  ],
).enableRLS();

export const agentCardMetadata = pgTable(
  "agent_card_metadata",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    publicId: varchar("publicId", { length: 12 }).notNull().unique(),
    cardId: bigint("cardId", { mode: "number" })
      .notNull()
      .references(() => cards.id, { onDelete: "cascade" }),
    source: agentSourceEnum("source"),
    sourceRef: text("sourceRef"),
    createdByKind: agentCreatedByKindEnum("createdByKind"),
    approvalState: agentApprovalStateEnum("approvalState")
      .notNull()
      .default("draft"),
    sensitivity: agentSensitivityEnum("sensitivity")
      .notNull()
      .default("normal"),
    relationshipRef: text("relationshipRef"),
    projectRef: text("projectRef"),
    lastAiSummary: text("lastAiSummary"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt"),
  },
  (table) => [
    uniqueIndex("agent_card_metadata_card_idx").on(table.cardId),
    index("agent_card_metadata_source_idx").on(table.source),
    index("agent_card_metadata_approval_idx").on(table.approvalState),
  ],
).enableRLS();

export const agentTokensRelations = relations(agentTokens, ({ one, many }) => ({
  workspace: one(workspaces, {
    fields: [agentTokens.workspaceId],
    references: [workspaces.id],
    relationName: "agentTokensWorkspace",
  }),
  board: one(boards, {
    fields: [agentTokens.boardId],
    references: [boards.id],
    relationName: "agentTokensBoard",
  }),
  createdByUser: one(users, {
    fields: [agentTokens.createdBy],
    references: [users.id],
    relationName: "agentTokensCreatedByUser",
  }),
  auditEvents: many(agentAuditEvents),
  proposals: many(agentProposals),
}));

export const agentAuditEventsRelations = relations(
  agentAuditEvents,
  ({ one }) => ({
    token: one(agentTokens, {
      fields: [agentAuditEvents.tokenId],
      references: [agentTokens.id],
      relationName: "agentAuditToken",
    }),
    workspace: one(workspaces, {
      fields: [agentAuditEvents.workspaceId],
      references: [workspaces.id],
      relationName: "agentAuditWorkspace",
    }),
    board: one(boards, {
      fields: [agentAuditEvents.boardId],
      references: [boards.id],
      relationName: "agentAuditBoard",
    }),
    card: one(cards, {
      fields: [agentAuditEvents.cardId],
      references: [cards.id],
      relationName: "agentAuditCard",
    }),
  }),
);

export const agentProposalsRelations = relations(agentProposals, ({ one }) => ({
  token: one(agentTokens, {
    fields: [agentProposals.tokenId],
    references: [agentTokens.id],
    relationName: "agentProposalToken",
  }),
  workspace: one(workspaces, {
    fields: [agentProposals.workspaceId],
    references: [workspaces.id],
    relationName: "agentProposalWorkspace",
  }),
  board: one(boards, {
    fields: [agentProposals.boardId],
    references: [boards.id],
    relationName: "agentProposalBoard",
  }),
  decidedByUser: one(users, {
    fields: [agentProposals.decidedBy],
    references: [users.id],
    relationName: "agentProposalDecidedByUser",
  }),
}));

export const agentCardMetadataRelations = relations(
  agentCardMetadata,
  ({ one }) => ({
    card: one(cards, {
      fields: [agentCardMetadata.cardId],
      references: [cards.id],
      relationName: "agentCardMetadataCard",
    }),
  }),
);
