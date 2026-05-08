import { TRPCError } from "@trpc/server";
import { z } from "zod";

import type { dbClient } from "@kan/db/client";
import * as agentRepo from "@kan/db/repository/agent.repo";
import * as boardRepo from "@kan/db/repository/board.repo";
import * as cardRepo from "@kan/db/repository/card.repo";
import * as cardActivityRepo from "@kan/db/repository/cardActivity.repo";
import * as cardCommentRepo from "@kan/db/repository/cardComment.repo";
import * as listRepo from "@kan/db/repository/list.repo";
import * as workspaceRepo from "@kan/db/repository/workspace.repo";
import { generateSlug, generateUID } from "@kan/shared/utils";

import { createTRPCRouter, protectedProcedure, publicProcedure } from "../trpc";
import { assertPermission } from "../utils/permissions";

type AgentToken = NonNullable<
  Awaited<ReturnType<typeof agentRepo.getTokenBySecret>>
>;

type AgentContext = {
  db: dbClient;
  headers: Headers;
  requestId: string;
  agentToken: AgentToken;
};

const agentScopeSchema = z.enum(agentRepo.allAgentScopes);

const agentSourceSchema = z.enum([
  "signal",
  "fastmail",
  "meeting",
  "forgejo",
  "manual",
  "obsidian",
  "iskra",
  "n8n",
]);

const agentCreatedByKindSchema = z.enum(["human", "iskra", "n8n", "import"]);
const agentSensitivitySchema = z.enum(["normal", "private", "sensitive"]);

const cardMetadataInputSchema = z.object({
  source: agentSourceSchema.optional(),
  sourceRef: z.string().max(2048).optional(),
  createdByKind: agentCreatedByKindSchema.optional(),
  sensitivity: agentSensitivitySchema.optional(),
  relationshipRef: z.string().max(2048).optional(),
  projectRef: z.string().max(2048).optional(),
  lastAiSummary: z.string().max(5000).optional(),
});

const isoDateTimeSchema = z.string().datetime({ offset: true });
const defaultOperationalTimeZone = "Europe/Warsaw";

const proposedActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("create_card"),
    listPublicId: z.string().min(12),
    title: z.string().min(1).max(2000),
    description: z.string().max(10000).optional(),
    dueDate: isoDateTimeSchema.nullable().optional(),
    metadata: cardMetadataInputSchema.optional(),
  }),
  z.object({
    type: z.literal("move_card"),
    cardPublicId: z.string().min(12),
    toListPublicId: z.string().min(12),
    index: z.number().int().min(0).optional(),
  }),
  z.object({
    type: z.literal("comment_card"),
    cardPublicId: z.string().min(12),
    comment: z.string().min(1).max(10000),
  }),
]);

const writeResultSchema = z.object({
  publicId: z.string(),
  title: z.string().optional(),
  listPublicId: z.string().optional(),
  auditPublicId: z.string().optional(),
  actor: z.string().optional(),
  mode: z.enum(["action"]).optional(),
  idempotencyKey: z.string().nullable().optional(),
  createdAt: z.date().optional(),
  idempotentReplay: z.boolean().optional(),
});
type WriteResult = z.infer<typeof writeResultSchema>;

const parseAgentSecret = (headers: Headers) => {
  const authorization = headers.get("authorization");
  if (authorization?.startsWith("Bearer ")) return authorization.slice(7);

  return headers.get("x-agent-token");
};

const agentProcedure = publicProcedure.use(async ({ ctx, next }) => {
  const tokenSecret = parseAgentSecret(ctx.headers);
  if (!tokenSecret) throw new TRPCError({ code: "UNAUTHORIZED" });

  const token = await agentRepo.getTokenBySecret(ctx.db, tokenSecret);
  if (!token?.active) throw new TRPCError({ code: "UNAUTHORIZED" });

  if (token.expiresAt && token.expiresAt.getTime() <= Date.now()) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Agent token expired",
    });
  }

  await agentRepo.touchToken(ctx.db, token.id);

  return next({
    ctx: {
      ...ctx,
      agentToken: token,
    },
  });
});

const assertScope = (token: AgentToken, scope: agentRepo.AgentScope) => {
  if (!token.scopes.includes(scope)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `Agent token is missing scope ${scope}`,
    });
  }
};

const assertWorkspaceScope = (
  token: AgentToken,
  workspaceId: number,
  workspacePublicId?: string,
) => {
  if (token.workspaceId !== workspaceId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: workspacePublicId
        ? `Agent token cannot access workspace ${workspacePublicId}`
        : "Agent token cannot access this workspace",
    });
  }
};

const assertBoardScope = (token: AgentToken, boardId: number) => {
  if (token.boardId && token.boardId !== boardId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Agent token cannot access this board",
    });
  }
};

const getDefaultWorkspaceForAgent = (token: AgentToken) => {
  if (!token.workspace) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Agent token is missing its workspace relation",
    });
  }

  return {
    id: token.workspaceId,
    publicId: token.workspace.publicId,
    name: token.workspace.name,
  };
};

const getWorkspaceForAgent = async (
  db: dbClient,
  token: AgentToken,
  workspacePublicId: string,
) => {
  const workspace = await workspaceRepo.getByPublicId(db, workspacePublicId);
  if (!workspace) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Workspace not found" });
  }

  assertWorkspaceScope(token, workspace.id, workspacePublicId);

  return workspace;
};

const getBoardForAgent = async (
  db: dbClient,
  token: AgentToken,
  boardPublicId: string,
) => {
  const board = await boardRepo.getWorkspaceAndBoardIdByBoardPublicId(
    db,
    boardPublicId,
  );
  if (!board) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Board not found" });
  }

  assertWorkspaceScope(token, board.workspaceId);
  assertBoardScope(token, board.id);

  return board;
};

const getListForAgent = async (
  db: dbClient,
  token: AgentToken,
  listPublicId: string,
) => {
  const list = await listRepo.getWorkspaceAndListIdByListPublicId(
    db,
    listPublicId,
  );
  if (!list) {
    throw new TRPCError({ code: "NOT_FOUND", message: "List not found" });
  }

  assertWorkspaceScope(token, list.workspaceId);
  const board = await getBoardForAgent(db, token, list.boardPublicId);

  return { ...list, boardId: board.id };
};

const getCardForAgent = async (
  db: dbClient,
  token: AgentToken,
  cardPublicId: string,
) => {
  const card = await cardRepo.getWorkspaceAndCardIdByCardPublicId(
    db,
    cardPublicId,
  );
  if (!card) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Card not found" });
  }

  assertWorkspaceScope(token, card.workspaceId);
  const board = await getBoardForAgent(db, token, card.boardPublicId);

  return { ...card, boardId: board.id };
};

const getIdempotencyKey = (
  ctx: Pick<AgentContext, "headers">,
  inputKey?: string | null,
) => inputKey ?? ctx.headers.get("idempotency-key");

const parseDueDate = (dueDate?: string | null) =>
  dueDate === undefined ? undefined : dueDate ? new Date(dueDate) : null;

const getTimeZoneParts = (date: Date, timeZone: string) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);

  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    second: value("second"),
  };
};

const getTimeZoneOffsetMs = (date: Date, timeZone: string) => {
  const parts = getTimeZoneParts(date, timeZone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );

  return asUtc - date.getTime();
};

const zonedDateTimeToUtc = (
  input: {
    year: number;
    month: number;
    day: number;
    hour?: number;
    minute?: number;
    second?: number;
  },
  timeZone: string,
) => {
  const utcGuess = new Date(
    Date.UTC(
      input.year,
      input.month - 1,
      input.day,
      input.hour ?? 0,
      input.minute ?? 0,
      input.second ?? 0,
    ),
  );
  const offset = getTimeZoneOffsetMs(utcGuess, timeZone);

  return new Date(utcGuess.getTime() - offset);
};

const getStartOfToday = (
  timeZone = defaultOperationalTimeZone,
  now = new Date(),
) => {
  const parts = getTimeZoneParts(now, timeZone);

  return zonedDateTimeToUtc(
    {
      year: parts.year,
      month: parts.month,
      day: parts.day,
    },
    timeZone,
  );
};

const resolveActivitySince = (input: {
  since?: string;
  today?: boolean;
}) => {
  if (input.since) return new Date(input.since);
  if (input.today) return getStartOfToday();

  return undefined;
};

const performCreateCard = async (
  ctx: AgentContext,
  input: {
    listPublicId: string;
    title: string;
    description?: string;
    dueDate?: string | null;
    metadata?: z.infer<typeof cardMetadataInputSchema>;
    idempotencyKey?: string | null;
  },
): Promise<WriteResult> => {
  assertScope(ctx.agentToken, "cards:create");

  const idempotencyKey = getIdempotencyKey(ctx, input.idempotencyKey);
  const replay = await agentRepo.findAuditByIdempotencyKey(ctx.db, {
    tokenId: ctx.agentToken.id,
    action: "create_card",
    idempotencyKey,
  });
  if (replay?.result) {
    return {
      ...(replay.result as WriteResult),
      auditPublicId: replay.publicId,
      actor: replay.actor,
      mode: "action",
      idempotencyKey: replay.idempotencyKey,
      createdAt: replay.createdAt,
      idempotentReplay: true,
    };
  }

  const list = await getListForAgent(
    ctx.db,
    ctx.agentToken,
    input.listPublicId,
  );
  const card = await cardRepo.create(ctx.db, {
    title: input.title,
    description: input.description ?? "",
    createdBy: ctx.agentToken.createdBy,
    listId: list.id,
    workspaceId: list.workspaceId,
    position: "end",
    dueDate: parseDueDate(input.dueDate),
  });

  await agentRepo.upsertCardMetadata(ctx.db, {
    cardId: card.id,
    source: input.metadata?.source ?? "iskra",
    sourceRef: input.metadata?.sourceRef,
    createdByKind: input.metadata?.createdByKind ?? "iskra",
    approvalState: "applied",
    sensitivity: input.metadata?.sensitivity,
    relationshipRef: input.metadata?.relationshipRef,
    projectRef: input.metadata?.projectRef,
    lastAiSummary: input.metadata?.lastAiSummary,
  });

  const result = {
    publicId: card.publicId,
    title: input.title,
    listPublicId: list.publicId,
    idempotentReplay: false,
  };

  const audit = await agentRepo.createAuditEvent(ctx.db, {
    tokenId: ctx.agentToken.id,
    workspaceId: list.workspaceId,
    boardId: list.boardId,
    cardId: card.id,
    action: "create_card",
    mode: "action",
    actor: ctx.agentToken.name,
    requestId: ctx.requestId,
    idempotencyKey,
    input,
    result,
  });

  return {
    ...result,
    auditPublicId: audit?.publicId,
    actor: ctx.agentToken.name,
    mode: "action",
    idempotencyKey,
    createdAt: audit?.createdAt,
  };
};

const performMoveCard = async (
  ctx: AgentContext,
  input: {
    cardPublicId: string;
    toListPublicId: string;
    index?: number;
    idempotencyKey?: string | null;
  },
): Promise<WriteResult> => {
  assertScope(ctx.agentToken, "cards:move");

  const idempotencyKey = getIdempotencyKey(ctx, input.idempotencyKey);
  const replay = await agentRepo.findAuditByIdempotencyKey(ctx.db, {
    tokenId: ctx.agentToken.id,
    action: "move_card",
    idempotencyKey,
  });
  if (replay?.result) {
    return {
      ...(replay.result as WriteResult),
      auditPublicId: replay.publicId,
      actor: replay.actor,
      mode: "action",
      idempotencyKey: replay.idempotencyKey,
      createdAt: replay.createdAt,
      idempotentReplay: true,
    };
  }

  const card = await getCardForAgent(
    ctx.db,
    ctx.agentToken,
    input.cardPublicId,
  );
  const targetList = await getListForAgent(
    ctx.db,
    ctx.agentToken,
    input.toListPublicId,
  );
  const sourceList = await listRepo.getWorkspaceAndListIdByListPublicId(
    ctx.db,
    card.listPublicId,
  );
  if (!sourceList) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Source list not found",
    });
  }

  if (targetList.boardId !== card.boardId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Cards can only be moved within the scoped board",
    });
  }

  const updated = await cardRepo.reorder(ctx.db, {
    cardId: card.id,
    newListId: targetList.id,
    newIndex: input.index,
  });
  if (!updated) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Failed to move card",
    });
  }

  await cardActivityRepo.create(ctx.db, {
    type: "card.updated.list",
    cardId: card.id,
    createdBy: ctx.agentToken.createdBy,
    fromListId: sourceList.id,
    toListId: targetList.id,
  });

  const result = {
    publicId: input.cardPublicId,
    title: updated.title,
    listPublicId: targetList.publicId,
    idempotentReplay: false,
  };

  const audit = await agentRepo.createAuditEvent(ctx.db, {
    tokenId: ctx.agentToken.id,
    workspaceId: card.workspaceId,
    boardId: card.boardId,
    cardId: card.id,
    action: "move_card",
    mode: "action",
    actor: ctx.agentToken.name,
    requestId: ctx.requestId,
    idempotencyKey,
    input,
    result,
  });

  return {
    ...result,
    auditPublicId: audit?.publicId,
    actor: ctx.agentToken.name,
    mode: "action",
    idempotencyKey,
    createdAt: audit?.createdAt,
  };
};

const performCommentCard = async (
  ctx: AgentContext,
  input: {
    cardPublicId: string;
    comment: string;
    idempotencyKey?: string | null;
  },
): Promise<WriteResult> => {
  assertScope(ctx.agentToken, "comments:create");

  const idempotencyKey = getIdempotencyKey(ctx, input.idempotencyKey);
  const replay = await agentRepo.findAuditByIdempotencyKey(ctx.db, {
    tokenId: ctx.agentToken.id,
    action: "comment_card",
    idempotencyKey,
  });
  if (replay?.result) {
    return {
      ...(replay.result as WriteResult),
      auditPublicId: replay.publicId,
      actor: replay.actor,
      mode: "action",
      idempotencyKey: replay.idempotencyKey,
      createdAt: replay.createdAt,
      idempotentReplay: true,
    };
  }

  const card = await getCardForAgent(
    ctx.db,
    ctx.agentToken,
    input.cardPublicId,
  );
  const comment = await cardCommentRepo.create(ctx.db, {
    comment: input.comment,
    createdBy: ctx.agentToken.createdBy,
    cardId: card.id,
  });

  if (!comment) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Failed to create comment",
    });
  }

  await cardActivityRepo.create(ctx.db, {
    type: "card.updated.comment.added",
    cardId: card.id,
    commentId: comment.id,
    toComment: comment.comment,
    createdBy: ctx.agentToken.createdBy,
  });

  const result = {
    publicId: comment.publicId,
    idempotentReplay: false,
  };

  const audit = await agentRepo.createAuditEvent(ctx.db, {
    tokenId: ctx.agentToken.id,
    workspaceId: card.workspaceId,
    boardId: card.boardId,
    cardId: card.id,
    action: "comment_card",
    mode: "action",
    actor: ctx.agentToken.name,
    requestId: ctx.requestId,
    idempotencyKey,
    input,
    result,
  });

  return {
    ...result,
    auditPublicId: audit?.publicId,
    actor: ctx.agentToken.name,
    mode: "action",
    idempotencyKey,
    createdAt: audit?.createdAt,
  };
};

const aiInboxLists = [
  "Captured",
  "Clarify",
  "Ready",
  "Doing",
  "Waiting",
  "Done / Archived",
] as const;

const getVisibleAiInbox = async (db: dbClient, token: AgentToken) => {
  const workspace = getDefaultWorkspaceForAgent(token);
  const board = await agentRepo.findBoardByName(db, {
    workspaceId: workspace.id,
    name: "AI Inbox",
  });

  if (!board) return null;
  if (token.boardId && token.boardId !== board.id) return null;

  return {
    boardPublicId: board.publicId,
    name: board.name,
    lists: board.lists.sort((a, b) => a.index - b.index),
  };
};

const ensureAiInboxForWorkspace = async (
  ctx: AgentContext,
  workspace: { id: number; publicId: string },
  auditInput: unknown,
) => {
  const existing = await agentRepo.findBoardByName(ctx.db, {
    workspaceId: workspace.id,
    name: "AI Inbox",
  });

  if (existing) {
    assertBoardScope(ctx.agentToken, existing.id);

    return {
      boardPublicId: existing.publicId,
      created: false,
      lists: existing.lists.sort((a, b) => a.index - b.index),
    };
  }

  if (ctx.agentToken.boardId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Board-scoped agent tokens cannot create AI Inbox",
    });
  }

  let slug = generateSlug("AI Inbox");
  const slugAvailable = await boardRepo.isBoardSlugAvailable(
    ctx.db,
    slug,
    workspace.id,
  );
  if (!slugAvailable) slug = `${slug}-${generateUID()}`;

  const board = await boardRepo.create(ctx.db, {
    name: "AI Inbox",
    createdBy: ctx.agentToken.createdBy,
    workspaceId: workspace.id,
    slug,
  });
  if (!board) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

  const createdLists = [];
  for (const name of aiInboxLists) {
    createdLists.push(
      await listRepo.create(ctx.db, {
        name,
        boardId: board.id,
        createdBy: ctx.agentToken.createdBy,
      }),
    );
  }

  await agentRepo.createAuditEvent(ctx.db, {
    tokenId: ctx.agentToken.id,
    workspaceId: workspace.id,
    boardId: board.id,
    action: "ensure_ai_inbox",
    mode: "setup",
    actor: ctx.agentToken.name,
    requestId: ctx.requestId,
    input: auditInput,
    result: { boardPublicId: board.publicId },
  });

  return {
    boardPublicId: board.publicId,
    created: true,
    lists: createdLists.map((list, index) => ({
      publicId: list.publicId,
      name: list.name,
      index,
    })),
  };
};

export const agentRouter = createTRPCRouter({
  createToken: protectedProcedure
    .meta({
      openapi: {
        summary: "Create an agent token",
        method: "POST",
        path: "/agent/tokens",
        description:
          "Creates a scoped machine token for Kan agent and MCP integrations.",
        tags: ["Agent"],
        protect: true,
      },
    })
    .input(
      z.object({
        workspacePublicId: z.string().min(12),
        boardPublicId: z.string().min(12).optional(),
        name: z.string().min(1).max(255),
        scopes: z.array(agentScopeSchema).min(1),
        expiresAt: z.string().datetime().nullable().optional(),
      }),
    )
    .output(
      z.object({
        publicId: z.string(),
        name: z.string(),
        token: z.string(),
        scopes: z.array(agentScopeSchema),
        expiresAt: z.date().nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user?.id;
      if (!userId) throw new TRPCError({ code: "UNAUTHORIZED" });

      const workspace = await workspaceRepo.getByPublicId(
        ctx.db,
        input.workspacePublicId,
      );
      if (!workspace) throw new TRPCError({ code: "NOT_FOUND" });

      await assertPermission(ctx.db, userId, workspace.id, "workspace:manage");

      const board = input.boardPublicId
        ? await boardRepo.getWorkspaceAndBoardIdByBoardPublicId(
            ctx.db,
            input.boardPublicId,
          )
        : null;

      if (input.boardPublicId && !board) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Board not found" });
      }

      if (board && board.workspaceId !== workspace.id) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Board does not belong to the requested workspace",
        });
      }

      return agentRepo.createToken(ctx.db, {
        name: input.name,
        workspaceId: workspace.id,
        boardId: board?.id,
        scopes: input.scopes,
        createdBy: userId,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      });
    }),

  getContext: agentProcedure
    .meta({
      openapi: {
        summary: "Agent default context",
        method: "GET",
        path: "/agent/context",
        description:
          "Returns the workspace, optional board scope, and existing AI Inbox visible to this token.",
        tags: ["Agent"],
        protect: true,
      },
    })
    .input(z.object({}))
    .output(
      z.object({
        workspace: z.object({
          publicId: z.string(),
          name: z.string(),
        }),
        boardScope: z
          .object({
            publicId: z.string(),
            name: z.string(),
          })
          .nullable(),
        aiInbox: z
          .object({
            boardPublicId: z.string(),
            name: z.string(),
            lists: z.array(
              z.object({
                publicId: z.string(),
                name: z.string(),
                index: z.number(),
              }),
            ),
          })
          .nullable(),
        scopes: z.array(agentScopeSchema),
      }),
    )
    .query(async ({ ctx }) => {
      assertScope(ctx.agentToken, "boards:read");
      const workspace = getDefaultWorkspaceForAgent(ctx.agentToken);
      const aiInbox = await getVisibleAiInbox(ctx.db, ctx.agentToken);

      return {
        workspace: {
          publicId: workspace.publicId,
          name: workspace.name,
        },
        boardScope: ctx.agentToken.board
          ? {
              publicId: ctx.agentToken.board.publicId,
              name: ctx.agentToken.board.name,
            }
          : null,
        aiInbox,
        scopes: ctx.agentToken.scopes,
      };
    }),

  listWorkspaces: agentProcedure
    .meta({
      openapi: {
        summary: "Agent list workspaces",
        method: "GET",
        path: "/agent/workspaces",
        description:
          "Lists the workspace visible to this scoped agent token. Agent tokens are intentionally single-workspace.",
        tags: ["Agent"],
        protect: true,
      },
    })
    .input(z.object({}))
    .output(
      z.array(
        z.object({
          publicId: z.string(),
          name: z.string(),
          default: z.boolean(),
        }),
      ),
    )
    .query(async ({ ctx }) => {
      assertScope(ctx.agentToken, "boards:read");
      const workspace = getDefaultWorkspaceForAgent(ctx.agentToken);

      return [
        {
          publicId: workspace.publicId,
          name: workspace.name,
          default: true,
        },
      ];
    }),

  listBoards: agentProcedure
    .meta({
      openapi: {
        summary: "Agent list boards",
        method: "GET",
        path: "/agent/workspaces/{workspacePublicId}/boards",
        description: "Lists boards visible to this agent token.",
        tags: ["Agent"],
        protect: true,
      },
    })
    .input(z.object({ workspacePublicId: z.string().min(12) }))
    .output(
      z.array(
        z.object({
          publicId: z.string(),
          name: z.string(),
          lists: z.array(
            z.object({
              publicId: z.string(),
              name: z.string(),
              index: z.number(),
            }),
          ),
        }),
      ),
    )
    .query(async ({ ctx, input }) => {
      assertScope(ctx.agentToken, "boards:read");
      const workspace = await getWorkspaceForAgent(
        ctx.db,
        ctx.agentToken,
        input.workspacePublicId,
      );

      const boards = await boardRepo.getAllByWorkspaceId(
        ctx.db,
        workspace.id,
        ctx.agentToken.createdBy,
        { archived: false, type: "regular" },
      );

      return boards
        .filter(
          (board) =>
            !ctx.agentToken.boardId ||
            board.publicId === ctx.agentToken.board?.publicId,
        )
        .map((board) => ({
          publicId: board.publicId,
          name: board.name,
          lists: board.lists,
        }));
    }),

  listColumns: agentProcedure
    .meta({
      openapi: {
        summary: "Agent list columns",
        method: "GET",
        path: "/agent/boards/{boardPublicId}/columns",
        description: "Lists columns for a board.",
        tags: ["Agent"],
        protect: true,
      },
    })
    .input(z.object({ boardPublicId: z.string().min(12) }))
    .output(
      z.array(
        z.object({
          publicId: z.string(),
          name: z.string(),
          index: z.number(),
        }),
      ),
    )
    .query(async ({ ctx, input }) => {
      assertScope(ctx.agentToken, "columns:read");
      await getBoardForAgent(ctx.db, ctx.agentToken, input.boardPublicId);
      const board = await boardRepo.getByPublicId(
        ctx.db,
        input.boardPublicId,
        ctx.agentToken.createdBy,
        {
          members: [],
          labels: [],
          lists: [],
          dueDate: [],
          type: "regular",
        },
      );

      if (!board) throw new TRPCError({ code: "NOT_FOUND" });

      return board.lists.map((list) => ({
        publicId: list.publicId,
        name: list.name,
        index: list.index,
      }));
    }),

  listCards: agentProcedure
    .meta({
      openapi: {
        summary: "Agent list cards",
        method: "GET",
        path: "/agent/boards/{boardPublicId}/cards",
        description: "Lists cards for a board, optionally filtered by column.",
        tags: ["Agent"],
        protect: true,
      },
    })
    .input(
      z.object({
        boardPublicId: z.string().min(12),
        listPublicId: z.string().min(12).optional(),
      }),
    )
    .output(
      z.array(
        z.object({
          publicId: z.string(),
          title: z.string(),
          description: z.string().nullable(),
          index: z.number(),
          dueDate: z.date().nullable(),
          listPublicId: z.string(),
          listName: z.string(),
        }),
      ),
    )
    .query(async ({ ctx, input }) => {
      assertScope(ctx.agentToken, "cards:read");
      await getBoardForAgent(ctx.db, ctx.agentToken, input.boardPublicId);

      const board = await boardRepo.getByPublicId(
        ctx.db,
        input.boardPublicId,
        ctx.agentToken.createdBy,
        {
          members: [],
          labels: [],
          lists: input.listPublicId ? [input.listPublicId] : [],
          dueDate: [],
          type: "regular",
        },
      );
      if (!board) throw new TRPCError({ code: "NOT_FOUND" });

      return board.lists
        .filter(
          (list) => !input.listPublicId || list.publicId === input.listPublicId,
        )
        .flatMap((list) =>
          list.cards.map((card) => ({
            publicId: card.publicId,
            title: card.title,
            description: card.description,
            index: card.index,
            dueDate: card.dueDate,
            listPublicId: list.publicId,
            listName: list.name,
          })),
        );
    }),

  searchCards: agentProcedure
    .meta({
      openapi: {
        summary: "Agent search cards",
        method: "GET",
        path: "/agent/workspaces/{workspacePublicId}/cards/search",
        description: "Searches cards in the scoped workspace.",
        tags: ["Agent"],
        protect: true,
      },
    })
    .input(
      z.object({
        workspacePublicId: z.string().min(12),
        query: z.string().min(1).max(100),
        limit: z.number().min(1).max(50).optional().default(20),
      }),
    )
    .output(
      z.array(
        z.object({
          publicId: z.string(),
          title: z.string(),
          description: z.string().nullable(),
          boardPublicId: z.string(),
          boardName: z.string(),
          listName: z.string(),
          cardNumber: z.number().nullable(),
          updatedAt: z.date().nullable(),
          createdAt: z.date(),
        }),
      ),
    )
    .query(async ({ ctx, input }) => {
      assertScope(ctx.agentToken, "cards:read");
      const workspace = await getWorkspaceForAgent(
        ctx.db,
        ctx.agentToken,
        input.workspacePublicId,
      );

      const results = await workspaceRepo.searchBoardsAndCards(
        ctx.db,
        workspace.id,
        input.query,
        input.limit,
      );

      return results
        .filter((result) => result.type === "card")
        .filter(
          (result) =>
            !ctx.agentToken.boardId ||
            result.boardPublicId === ctx.agentToken.board?.publicId,
        )
        .map((result) => ({
          publicId: result.publicId,
          title: result.title,
          description: result.description,
          boardPublicId: result.boardPublicId,
          boardName: result.boardName,
          listName: result.listName,
          cardNumber: result.cardNumber,
          updatedAt: result.updatedAt,
          createdAt: result.createdAt,
        }));
    }),

  getCardContext: agentProcedure
    .meta({
      openapi: {
        summary: "Agent get card context",
        method: "GET",
        path: "/agent/cards/{cardPublicId}",
        description: "Returns task context useful for an AI assistant.",
        tags: ["Agent"],
        protect: true,
      },
    })
    .input(z.object({ cardPublicId: z.string().min(12) }))
    .output(
      z.object({
        publicId: z.string(),
        title: z.string(),
        description: z.string().nullable(),
        dueDate: z.date().nullable(),
        list: z.object({ publicId: z.string(), name: z.string() }),
        board: z.object({ publicId: z.string(), name: z.string() }),
        labels: z.array(z.object({ publicId: z.string(), name: z.string() })),
      }),
    )
    .query(async ({ ctx, input }) => {
      assertScope(ctx.agentToken, "cards:read");
      await getCardForAgent(ctx.db, ctx.agentToken, input.cardPublicId);
      const card = await cardRepo.getWithListAndMembersByPublicId(
        ctx.db,
        input.cardPublicId,
      );
      if (!card) throw new TRPCError({ code: "NOT_FOUND" });

      return {
        publicId: card.publicId,
        title: card.title,
        description: card.description,
        dueDate: card.dueDate,
        list: {
          publicId: card.list.publicId,
          name: card.list.name,
        },
        board: {
          publicId: card.list.board.publicId,
          name: card.list.board.name,
        },
        labels: card.labels.map((label) => ({
          publicId: label.publicId,
          name: label.name,
        })),
      };
    }),

  getRecentActivity: agentProcedure
    .meta({
      openapi: {
        summary: "Agent get recent activity",
        method: "GET",
        path: "/agent/workspaces/{workspacePublicId}/activity",
        description:
          "Returns recent human and agent activity for recap questions. Datetimes accept timezone offsets and are normalized to UTC. Use today=true for the current Europe/Warsaw day.",
        tags: ["Agent"],
        protect: true,
      },
    })
    .input(
      z.object({
        workspacePublicId: z.string().min(12),
        boardPublicId: z.string().min(12).optional(),
        since: isoDateTimeSchema.optional(),
        today: z.boolean().optional().default(false),
        onlyMoves: z.boolean().optional().default(false),
        includeAgentAudit: z.boolean().optional().default(true),
        actor: z.string().min(1).max(255).optional(),
        action: z.string().min(1).max(100).optional(),
        source: agentSourceSchema.optional(),
        limit: z.number().min(1).max(100).optional().default(20),
      }),
    )
    .output(
      z.object({
        cardActivities: z.array(
          z.object({
            publicId: z.string(),
            type: z.string(),
            createdAt: z.date(),
            cardPublicId: z.string(),
            cardTitle: z.string(),
            boardPublicId: z.string(),
            boardName: z.string(),
            fromListName: z.string().nullable(),
            toListName: z.string().nullable(),
            actorName: z.string().nullable(),
            actorEmail: z.string().nullable(),
            actorKind: z.enum(["human", "agent"]),
            displayActorName: z.string().nullable(),
            viaAgentTokenName: z.string().nullable(),
            agentAuditPublicId: z.string().nullable(),
            source: agentSourceSchema.nullable(),
            sourceRef: z.string().nullable(),
            createdByKind: agentCreatedByKindSchema.nullable(),
            sensitivity: agentSensitivitySchema.nullable(),
          }),
        ),
        agentAudit: z.array(
          z.object({
            publicId: z.string(),
            auditPublicId: z.string(),
            action: z.string(),
            mode: z.string(),
            actor: z.string(),
            idempotencyKey: z.string().nullable(),
            input: z.unknown().nullable(),
            result: z.unknown().nullable(),
            createdAt: z.date(),
            cardPublicId: z.string().nullable(),
            cardTitle: z.string().nullable(),
            source: agentSourceSchema.nullable(),
            sourceRef: z.string().nullable(),
            createdByKind: agentCreatedByKindSchema.nullable(),
            sensitivity: agentSensitivitySchema.nullable(),
          }),
        ),
      }),
    )
    .query(async ({ ctx, input }) => {
      assertScope(ctx.agentToken, "activity:read");
      const workspace = await getWorkspaceForAgent(
        ctx.db,
        ctx.agentToken,
        input.workspacePublicId,
      );
      const board = input.boardPublicId
        ? await getBoardForAgent(ctx.db, ctx.agentToken, input.boardPublicId)
        : null;

      const scopedBoardId = board?.id ?? ctx.agentToken.boardId;
      const since = resolveActivitySince(input);

      const [rawCardActivities, rawAgentAudit] = await Promise.all([
        agentRepo.getRecentCardActivity(ctx.db, {
          workspaceId: workspace.id,
          boardId: scopedBoardId,
          since,
          onlyMoves: input.onlyMoves,
          limit: input.actor ? 100 : input.limit,
          action: input.action,
          source: input.source,
        }),
        agentRepo.getRecentAgentAudit(ctx.db, {
          workspaceId: workspace.id,
          boardId: scopedBoardId,
          since,
          limit: input.limit,
          actor: input.actor,
          action: input.action,
          source: input.source,
        }),
      ]);

      const agentAudit = rawAgentAudit.map((audit) => ({
        ...audit,
        auditPublicId: audit.publicId,
      }));

      const actorQuery = input.actor?.trim().toLowerCase();
      const cardActivities = rawCardActivities
        .map((activity) => {
          const matchingAudit = agentAudit.find((audit) => {
            if (audit.action !== "move_card") return false;
            if (audit.cardPublicId !== activity.cardPublicId) return false;

            return (
              Math.abs(
                audit.createdAt.getTime() - activity.createdAt.getTime(),
              ) < 10_000
            );
          });
          const displayActorName =
            matchingAudit?.actor ?? activity.actorName ?? activity.actorEmail;

          return {
            ...activity,
            actorKind: matchingAudit ? ("agent" as const) : ("human" as const),
            displayActorName,
            viaAgentTokenName: matchingAudit?.actor ?? null,
            agentAuditPublicId: matchingAudit?.publicId ?? null,
          };
        })
        .filter((activity) =>
          actorQuery
            ? activity.displayActorName?.toLowerCase().includes(actorQuery)
            : true,
        )
        .slice(0, input.limit);

      return {
        cardActivities,
        agentAudit: input.includeAgentAudit ? agentAudit : [],
      };
    }),

  createCard: agentProcedure
    .meta({
      openapi: {
        summary: "Agent create card",
        method: "POST",
        path: "/agent/cards",
        description: "Creates a card through the narrow action surface.",
        tags: ["Agent"],
        protect: true,
      },
    })
    .input(
      z.object({
        listPublicId: z.string().min(12),
        title: z.string().min(1).max(2000),
        description: z.string().max(10000).optional(),
        dueDate: isoDateTimeSchema.nullable().optional(),
        metadata: cardMetadataInputSchema.optional(),
        idempotencyKey: z.string().max(255).optional(),
      }),
    )
    .output(writeResultSchema)
    .mutation(({ ctx, input }) => performCreateCard(ctx, input)),

  moveCard: agentProcedure
    .meta({
      openapi: {
        summary: "Agent move card",
        method: "POST",
        path: "/agent/cards/{cardPublicId}/move",
        description:
          "Moves a card to another column through the narrow action surface.",
        tags: ["Agent"],
        protect: true,
      },
    })
    .input(
      z.object({
        cardPublicId: z.string().min(12),
        toListPublicId: z.string().min(12),
        index: z.number().int().min(0).optional(),
        idempotencyKey: z.string().max(255).optional(),
      }),
    )
    .output(writeResultSchema)
    .mutation(({ ctx, input }) => performMoveCard(ctx, input)),

  commentCard: agentProcedure
    .meta({
      openapi: {
        summary: "Agent comment card",
        method: "POST",
        path: "/agent/cards/{cardPublicId}/comments",
        description: "Adds a comment through the narrow action surface.",
        tags: ["Agent"],
        protect: true,
      },
    })
    .input(
      z.object({
        cardPublicId: z.string().min(12),
        comment: z.string().min(1).max(10000),
        idempotencyKey: z.string().max(255).optional(),
      }),
    )
    .output(writeResultSchema)
    .mutation(({ ctx, input }) => performCommentCard(ctx, input)),

  proposeBoardUpdate: agentProcedure
    .meta({
      openapi: {
        summary: "Agent propose board update",
        method: "POST",
        path: "/agent/proposals",
        description: "Stores a dry-run proposal for human approval.",
        tags: ["Agent"],
        protect: true,
      },
    })
    .input(
      z.object({
        workspacePublicId: z.string().min(12),
        boardPublicId: z.string().min(12).optional(),
        title: z.string().min(1).max(255),
        summary: z.string().max(5000).optional(),
        actions: z.array(proposedActionSchema).min(1).max(20),
      }),
    )
    .output(
      z.object({
        publicId: z.string(),
        title: z.string(),
        status: z.string(),
        createdAt: z.date(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      assertScope(ctx.agentToken, "proposals:create");
      const workspace = await getWorkspaceForAgent(
        ctx.db,
        ctx.agentToken,
        input.workspacePublicId,
      );
      const board = input.boardPublicId
        ? await getBoardForAgent(ctx.db, ctx.agentToken, input.boardPublicId)
        : null;

      const proposal = await agentRepo.createProposal(ctx.db, {
        tokenId: ctx.agentToken.id,
        workspaceId: workspace.id,
        boardId: board?.id ?? ctx.agentToken.boardId ?? null,
        title: input.title,
        summary: input.summary,
        actions: input.actions,
        createdBy: ctx.agentToken.name,
      });

      await agentRepo.createAuditEvent(ctx.db, {
        tokenId: ctx.agentToken.id,
        workspaceId: workspace.id,
        boardId: board?.id ?? ctx.agentToken.boardId ?? null,
        action: "propose_board_update",
        mode: "proposal",
        actor: ctx.agentToken.name,
        requestId: ctx.requestId,
        input,
        result: proposal,
      });

      return proposal;
    }),

  approveProposal: protectedProcedure
    .meta({
      openapi: {
        summary: "Approve an agent proposal",
        method: "POST",
        path: "/agent/proposals/{proposalPublicId}/approve",
        description: "Marks a proposal as approved for later application.",
        tags: ["Agent"],
        protect: true,
      },
    })
    .input(z.object({ proposalPublicId: z.string().min(12) }))
    .output(z.object({ publicId: z.string(), status: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user?.id;
      if (!userId) throw new TRPCError({ code: "UNAUTHORIZED" });

      const proposal = await agentRepo.getProposalByPublicId(
        ctx.db,
        input.proposalPublicId,
      );
      if (!proposal) throw new TRPCError({ code: "NOT_FOUND" });

      await assertPermission(
        ctx.db,
        userId,
        proposal.workspaceId,
        "board:edit",
      );

      const updated = await agentRepo.updateProposalStatus(ctx.db, {
        proposalPublicId: input.proposalPublicId,
        status: "approved",
        decidedBy: userId,
      });

      if (!updated) throw new TRPCError({ code: "NOT_FOUND" });
      return updated;
    }),

  rejectProposal: protectedProcedure
    .meta({
      openapi: {
        summary: "Reject an agent proposal",
        method: "POST",
        path: "/agent/proposals/{proposalPublicId}/reject",
        description: "Rejects a proposal.",
        tags: ["Agent"],
        protect: true,
      },
    })
    .input(z.object({ proposalPublicId: z.string().min(12) }))
    .output(z.object({ publicId: z.string(), status: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user?.id;
      if (!userId) throw new TRPCError({ code: "UNAUTHORIZED" });

      const proposal = await agentRepo.getProposalByPublicId(
        ctx.db,
        input.proposalPublicId,
      );
      if (!proposal) throw new TRPCError({ code: "NOT_FOUND" });

      await assertPermission(
        ctx.db,
        userId,
        proposal.workspaceId,
        "board:edit",
      );

      const updated = await agentRepo.updateProposalStatus(ctx.db, {
        proposalPublicId: input.proposalPublicId,
        status: "rejected",
        decidedBy: userId,
      });

      if (!updated) throw new TRPCError({ code: "NOT_FOUND" });
      return updated;
    }),

  applyApprovedUpdate: agentProcedure
    .meta({
      openapi: {
        summary: "Apply approved agent proposal",
        method: "POST",
        path: "/agent/proposals/{proposalPublicId}/apply",
        description: "Applies an already-approved proposal.",
        tags: ["Agent"],
        protect: true,
      },
    })
    .input(
      z.object({
        proposalPublicId: z.string().min(12),
        idempotencyKey: z.string().max(255).optional(),
      }),
    )
    .output(
      z.object({
        publicId: z.string(),
        status: z.string(),
        results: z.array(writeResultSchema),
        auditPublicId: z.string().optional(),
        actor: z.string().optional(),
        mode: z.enum(["action"]).optional(),
        idempotencyKey: z.string().nullable().optional(),
        createdAt: z.date().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      assertScope(ctx.agentToken, "proposals:apply");
      const proposal = await agentRepo.getProposalByPublicId(
        ctx.db,
        input.proposalPublicId,
      );
      if (!proposal) throw new TRPCError({ code: "NOT_FOUND" });
      if (proposal.status !== "approved") {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Proposal must be approved before it can be applied",
        });
      }

      assertWorkspaceScope(ctx.agentToken, proposal.workspaceId);
      if (proposal.boardId) assertBoardScope(ctx.agentToken, proposal.boardId);

      const parsedActions = z
        .array(proposedActionSchema)
        .parse(proposal.actions);
      const baseKey = getIdempotencyKey(ctx, input.idempotencyKey);
      const results = [];

      for (const [index, action] of parsedActions.entries()) {
        const idempotencyKey = baseKey
          ? `${baseKey}:${index}:${action.type}`
          : undefined;

        if (action.type === "create_card") {
          results.push(
            await performCreateCard(ctx, { ...action, idempotencyKey }),
          );
        } else if (action.type === "move_card") {
          results.push(
            await performMoveCard(ctx, {
              cardPublicId: action.cardPublicId,
              toListPublicId: action.toListPublicId,
              index: action.index,
              idempotencyKey,
            }),
          );
        } else {
          results.push(
            await performCommentCard(ctx, { ...action, idempotencyKey }),
          );
        }
      }

      await agentRepo.updateProposalStatus(ctx.db, {
        proposalPublicId: input.proposalPublicId,
        status: "applied",
        appliedAt: new Date(),
      });

      const audit = await agentRepo.createAuditEvent(ctx.db, {
        tokenId: ctx.agentToken.id,
        workspaceId: proposal.workspaceId,
        boardId: proposal.boardId,
        action: "apply_approved_update",
        mode: "action",
        actor: ctx.agentToken.name,
        requestId: ctx.requestId,
        idempotencyKey: baseKey,
        input,
        result: results,
      });

      return {
        publicId: proposal.publicId,
        status: "applied",
        results,
        auditPublicId: audit?.publicId,
        actor: ctx.agentToken.name,
        mode: "action",
        idempotencyKey: baseKey,
        createdAt: audit?.createdAt,
      };
    }),

  ensureAiInbox: agentProcedure
    .meta({
      openapi: {
        summary: "Ensure AI Inbox board",
        method: "POST",
        path: "/agent/workspaces/{workspacePublicId}/ai-inbox",
        description: "Creates the AI Inbox board convention if it is missing.",
        tags: ["Agent"],
        protect: true,
      },
    })
    .input(z.object({ workspacePublicId: z.string().min(12) }))
    .output(
      z.object({
        boardPublicId: z.string(),
        created: z.boolean(),
        lists: z.array(
          z.object({
            publicId: z.string(),
            name: z.string(),
            index: z.number(),
          }),
        ),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      assertScope(ctx.agentToken, "inbox:manage");
      const workspace = await getWorkspaceForAgent(
        ctx.db,
        ctx.agentToken,
        input.workspacePublicId,
      );

      return ensureAiInboxForWorkspace(ctx, workspace, input);
    }),

  ensureDefaultAiInbox: agentProcedure
    .meta({
      openapi: {
        summary: "Ensure default AI Inbox board",
        method: "POST",
        path: "/agent/ai-inbox",
        description:
          "Creates or returns AI Inbox in the token's default workspace.",
        tags: ["Agent"],
        protect: true,
      },
    })
    .input(z.object({}))
    .output(
      z.object({
        boardPublicId: z.string(),
        created: z.boolean(),
        lists: z.array(
          z.object({
            publicId: z.string(),
            name: z.string(),
            index: z.number(),
          }),
        ),
      }),
    )
    .mutation(async ({ ctx }) => {
      assertScope(ctx.agentToken, "inbox:manage");
      const workspace = getDefaultWorkspaceForAgent(ctx.agentToken);

      return ensureAiInboxForWorkspace(ctx, workspace, {
        workspacePublicId: workspace.publicId,
      });
    }),
});
